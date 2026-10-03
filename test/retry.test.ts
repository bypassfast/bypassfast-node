import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIError } from "../src/index.js";
import {
  fullJitter,
  parseHttpDate,
  parseRetryAfterHeader,
  parseRetryAfterMs,
  retryDelay,
  solverBusyDelay,
  type RetryPolicy,
} from "../src/retry.js";
import { cdRequest, fakeFetch, reply, testClient, type RecordedRequest } from "./helpers.js";

const SECOND = 1000;
const HOUR = 3_600_000;
const low = (): number => 0;
const high = (ceiling: number): number => ceiling;

describe("solverBusyDelay", () => {
  const vectors: { name: string; retry: number; hint: number; remaining?: number; min: number; max: number }[] = [
    { name: "no hint uses the one-second floor", retry: 1, hint: 0, min: SECOND, max: 2 * SECOND },
    { name: "window doubles", retry: 2, hint: SECOND, min: SECOND, max: 4 * SECOND },
    { name: "third retry", retry: 3, hint: SECOND, min: SECOND, max: 8 * SECOND },
    { name: "window caps at ten seconds", retry: 4, hint: SECOND, min: SECOND, max: 10 * SECOND },
    { name: "cap holds for long streaks", retry: 60, hint: SECOND, min: SECOND, max: 10 * SECOND },
    { name: "millisecond hint is the floor", retry: 1, hint: 250, min: 250, max: 500 },
    { name: "small hint still reaches the cap", retry: 8, hint: 250, min: 250, max: 10 * SECOND },
    { name: "hint above the cap keeps a jitter window", retry: 3, hint: 20 * SECOND, min: 20 * SECOND, max: 40 * SECOND },
    { name: "safety cap", retry: 1, hint: 2 * HOUR, min: HOUR, max: HOUR },
    { name: "window narrows to the remaining budget", retry: 1, hint: 30 * SECOND, remaining: 40 * SECOND, min: 30 * SECOND, max: 40 * SECOND },
    { name: "floor exactly fills the remaining budget", retry: 2, hint: 5 * SECOND, remaining: 5 * SECOND, min: 5 * SECOND, max: 5 * SECOND },
    { name: "floor beyond the remaining budget is not undercut", retry: 1, hint: 30 * SECOND, remaining: 10 * SECOND, min: 30 * SECOND, max: 60 * SECOND },
    { name: "spent budget keeps the full window", retry: 1, hint: 0, remaining: -SECOND, min: SECOND, max: 2 * SECOND },
  ];
  for (const vector of vectors) {
    it(vector.name, () => {
      const remaining = vector.remaining ?? HOUR;
      assert.equal(solverBusyDelay(vector.retry, vector.hint, remaining, low), vector.min);
      assert.equal(solverBusyDelay(vector.retry, vector.hint, remaining, high), vector.max);
      for (let i = 0; i < 200; i++) {
        const delay = solverBusyDelay(vector.retry, vector.hint, remaining, fullJitter);
        assert.ok(delay >= vector.min && delay <= vector.max, `${delay} outside [${vector.min}, ${vector.max}]`);
      }
    });
  }
});

describe("retryDelay", () => {
  const policy: RetryPolicy = { maxRetries: 10, baseDelayMs: 500, maxDelayMs: 8000 };

  it("doubles the backoff ceiling up to maxDelayMs", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 10].map((retry) => retryDelay(retry, 0, policy, high)),
      [500, 1000, 2000, 4000, 8000, 8000, 8000],
    );
    assert.equal(retryDelay(3, 0, policy, low), 0);
  });

  it("jumps to maxDelayMs instead of overshooting it", () => {
    const odd: RetryPolicy = { maxRetries: 10, baseDelayMs: 500, maxDelayMs: 1200 };
    assert.deepEqual([1, 2, 3].map((retry) => retryDelay(retry, 0, odd, high)), [500, 1000, 1200]);
  });

  it("lets a larger server hint win", () => {
    assert.equal(retryDelay(1, 3000, policy, high), 3000);
    assert.equal(retryDelay(1, 300, policy, high), 500);
    assert.equal(retryDelay(1, 300, policy, low), 300);
  });

  it("is zero without a base delay or hint", () => {
    assert.equal(retryDelay(4, 0, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 }, high), 0);
  });
});

describe("fullJitter", () => {
  it("returns an integer in [0, ceiling]", () => {
    assert.equal(fullJitter(0), 0);
    assert.equal(fullJitter(-5), 0);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const value = fullJitter(3);
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 3);
      seen.add(value);
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  });
});

describe("retry hints", () => {
  it("parses retry_after_ms", () => {
    const cases: [unknown, number][] = [
      [1500, 1500],
      [2.5, 2.5],
      [undefined, 0],
      [null, 0],
      [0, 0],
      [-5, 0],
      ["1500", 0],
      [{}, 0],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NaN, 0],
      [1e12, HOUR],
      [HOUR, HOUR],
    ];
    for (const [value, expected] of cases) {
      assert.equal(parseRetryAfterMs(value), expected, String(value));
    }
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.UTC(2026, 8, 13, 12, 0, 0);
    const cases: [string | null, number][] = [
      ["2", 2000],
      [" 2 ", 2000],
      ["+2", 2000],
      ["0", 0],
      ["-1", 0],
      ["3599", 3_599_000],
      ["3600", HOUR],
      ["9223372036854775807", HOUR],
      ["99999999999999999999", 0],
      ["", 0],
      [null, 0],
      ["soon", 0],
      ["1.5", 0],
      ["Sun, 13 Sep 2026 12:00:03 GMT", 3000],
      ["Sunday, 13-Sep-26 12:00:03 GMT", 3000],
      ["Sun Sep 13 12:00:03 2026", 3000],
      ["Sun, 13 Sep 2026 12:00:00 GMT", 0],
      ["Sun, 13 Sep 2026 11:00:00 GMT", 0],
      ["Mon, 14 Sep 2026 12:00:00 GMT", HOUR],
      ["Sun, 13 Sep 2026 12:00:03 UTC", 0],
    ];
    for (const [value, expected] of cases) {
      assert.equal(parseRetryAfterHeader(value, now), expected, String(value));
    }
    assert.equal(parseHttpDate("Sat, 31 Feb 2026 00:00:00 GMT"), undefined);
    assert.equal(parseHttpDate("Thu Oct  1 08:00:00 2026"), Date.UTC(2026, 9, 1, 8, 0, 0));
  });
});

/** Answers each request with the next scripted response; the last one repeats. */
function scripted(...responses: (() => Response)[]): ReturnType<typeof fakeFetch> {
  return fakeFetch((_request: RecordedRequest, index: number) => {
    const next = responses[Math.min(index, responses.length - 1)];
    assert.ok(next);
    return next();
  });
}

const busy = (hintMs?: number, headers: Record<string, string> = {}) => () =>
  reply(429, hintMs === undefined ? { error: "solver_busy" } : { error: "solver_busy", retry_after_ms: hintMs }, headers);
const ok = () => reply(200, { payload: "ok", duration_ms: 1 });

describe("retry loop", () => {
  it("retries an explicit retryable response and counts attempts", async () => {
    const { fetch, requests } = scripted(() => reply(503, { error: "solver_unavailable" }), ok);
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 } }, { jitter: high });
    const result = await client.kasada.cd(cdRequest);
    assert.equal(requests.length, 2);
    assert.equal(result.response.attempts, 2);
    assert.deepEqual(clock.sleeps, [500]);
  });

  it("stops after maxRetries and reports every attempt", async () => {
    const { fetch, requests } = scripted(() => reply(503, { error: "solver_unavailable" }));
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 8000 } }, { jitter: high });
    const error = await client.kasada.cd(cdRequest).catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError);
    assert.equal(error.response.attempts, 3);
    assert.equal(requests.length, 3);
    assert.deepEqual(clock.sleeps, [500, 1000]);
  });

  it("never retries non-retryable codes", async () => {
    for (const response of [
      () => reply(429, { error: "quota_exceeded", retry_after_ms: 1 }, { "retry-after": "1" }),
      () => reply(409, { error_code: "script_cache_miss" }),
      () => reply(424, { error: "proxy_error", reason: "proxy_auth_failed" }),
      () => reply(400, { error: "invalid_body" }),
    ]) {
      const { fetch, requests } = scripted(response);
      const { client } = testClient(fetch, { retry: { maxRetries: 2 }, solverBusyRetryBudgetMs: 60_000 });
      await assert.rejects(client.kasada.cd(cdRequest), APIError);
      assert.equal(requests.length, 1);
    }
  });

  it("retries internal errors only once", async () => {
    const internal = () => reply(500, { error: "internal_error" });
    const alone = scripted(internal);
    await assert.rejects(testClient(alone.fetch, { retry: { maxRetries: 2 } }).client.kasada.cd(cdRequest), { code: "internal_error" });
    assert.equal(alone.requests.length, 2);

    // A solver_busy retry does not use up the single internal retry.
    const afterBusy = scripted(busy(1), internal);
    await assert.rejects(testClient(afterBusy.fetch, { retry: { maxRetries: 2 } }).client.kasada.cd(cdRequest), { code: "internal_error" });
    assert.equal(afterBusy.requests.length, 3);
  });

  it("maxRetries 0 disables every retry, solver_busy included", async () => {
    for (const response of [busy(1), () => reply(503, { error: "solver_unavailable" })]) {
      const { fetch, requests } = scripted(response);
      await assert.rejects(testClient(fetch, { retry: { maxRetries: 0 } }).client.kasada.cd(cdRequest), APIError);
      assert.equal(requests.length, 1);
    }
  });

  it("solver_busy retries do not consume maxRetries, and the body hint beats Retry-After", async () => {
    const { fetch, requests } = scripted(busy(1, { "retry-after": "1" }), busy(1, { "retry-after": "1" }), busy(1, { "retry-after": "1" }), ok);
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 1 } });
    const result = await client.kasada.cd(cdRequest);
    assert.equal(requests.length, 4);
    assert.equal(result.response.attempts, 4);
    assert.deepEqual(clock.sleeps, [1, 1, 1], "the 1 ms body hint is the floor; the 1 s header is ignored");
  });

  it("uses Retry-After only when the body has no valid hint", async () => {
    const cases: [body: Record<string, unknown>, expected: number][] = [
      [{ error: "solver_busy" }, 2000],
      [{ error: "solver_busy", retry_after_ms: 300 }, 300],
      [{ error: "solver_busy", retry_after_ms: "soon" }, 2000],
    ];
    for (const [body, expected] of cases) {
      const final = await testClient(scripted(() => reply(429, body, { "retry-after": "2" })).fetch)
        .client.kasada.cd(cdRequest)
        .catch((caught: unknown) => caught);
      assert.ok(final instanceof APIError);
      assert.equal(final.retryAfterMs, expected);

      const { fetch } = scripted(() => reply(429, body, { "retry-after": "2" }), ok);
      const { client, clock } = testClient(fetch, { retry: { maxRetries: 1 } });
      await client.kasada.cd(cdRequest);
      assert.deepEqual(clock.sleeps, [expected], JSON.stringify(body));
    }
  });

  it("an ordinary retry waits at least the server hint", async () => {
    const { fetch } = scripted(() => reply(503, { error: "edge_unavailable" }, { "retry-after": "3" }), ok);
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 8000 } }, { jitter: high });
    await client.kasada.cd(cdRequest);
    assert.deepEqual(clock.sleeps, [3000]);
  });

  it("stops retrying solver_busy when the budget is spent", async () => {
    const { fetch, requests } = scripted(busy(5));
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 1 }, solverBusyRetryBudgetMs: 200 }, { jitter: high });
    const error = await client.kasada.cd(cdRequest).catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError);
    assert.equal(error.code, "solver_busy");
    assert.equal(error.retryAfterMs, 5);
    // Windows double from the 5 ms floor and the last one narrows to the 50 ms left.
    assert.deepEqual(clock.sleeps, [10, 20, 40, 80, 50]);
    assert.equal(requests.length, 6);
    assert.equal(error.response.attempts, 6);
  });

  it("waits out a long hint that fits the budget, and each call gets a fresh budget", async () => {
    let call = 0;
    const { fetch } = fakeFetch(() => (call++ % 2 === 0 ? busy(300)() : ok()));
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 1 }, solverBusyRetryBudgetMs: 500 }, { jitter: high });
    for (let i = 0; i < 5; i++) {
      const result = await client.kasada.cd(cdRequest);
      assert.equal(result.response.attempts, 2);
    }
    assert.deepEqual(clock.sleeps, [500, 500, 500, 500, 500]);
  });

  it("does not wait for a solver_busy retry that cannot start before the deadline", async () => {
    const { fetch, requests } = scripted(busy(2000));
    const { client, clock } = testClient(fetch, { retry: { maxRetries: 1 } });
    const error = await client.kasada
      .cd(cdRequest, { deadline: clock.now + 1000 })
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError, "the caller gets the capacity error, not a timeout");
    assert.equal(error.code, "solver_busy");
    assert.equal(requests.length, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  it("a zero budget disables solver_busy retries", async () => {
    const { fetch, requests } = scripted(busy(1));
    await assert.rejects(
      testClient(fetch, { retry: { maxRetries: 2 }, solverBusyRetryBudgetMs: 0 }).client.kasada.cd(cdRequest),
      { code: "solver_busy" },
    );
    assert.equal(requests.length, 1);
  });

  it("an abort signal cancels a backoff wait", async () => {
    // Real timers: the default sleep must reject as soon as the signal aborts.
    const { fetch, requests } = scripted(busy(5000));
    const { client } = testClient(fetch, { retry: { maxRetries: 1 } }, { sleep: undefined, now: undefined });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await assert.rejects(client.kasada.cd(cdRequest, { signal: controller.signal }), { name: "AbortError" });
    assert.ok(Date.now() - started < 4000, "the 5 s wait was not cancelled");
    assert.equal(requests.length, 1);

    const reason = new Error("shutting down");
    const second = new AbortController();
    setTimeout(() => second.abort(reason), 20);
    await assert.rejects(client.kasada.cd(cdRequest, { signal: second.signal }), (error: unknown) => error === reason);
  });

  it("a deadline cancels an ordinary backoff wait", async () => {
    const { fetch } = scripted(() => reply(503, { error: "solver_unavailable" }, { "retry-after": "5" }));
    const { client } = testClient(fetch, { retry: { maxRetries: 1 } }, { sleep: undefined, now: undefined });
    const started = Date.now();
    await assert.rejects(client.kasada.cd(cdRequest, { deadline: Date.now() + 30 }), { name: "TimeoutError" });
    assert.ok(Date.now() - started < 4000);
  });
});
