import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import {
  APIError,
  BypassFast,
  BypassFastError,
  RequestError,
  ResponseError,
  ValidationError,
  VERSION,
  type BypassFastOptions,
} from "../src/index.js";
import { cdRequest, fakeFetch, hang, reply, testClient } from "./helpers.js";

const MiB = 1024 * 1024;

function construct(apiKey: string, options?: BypassFastOptions): unknown {
  try {
    new BypassFast(apiKey, { fetch: async () => reply(200, {}), ...options });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("client construction", () => {
  it("matches the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  it("rejects bad API keys", () => {
    for (const key of ["", " key", "key ", "ke\ny", "key\r", "\tkey"]) {
      const error = construct(key);
      assert.ok(error instanceof ValidationError, `key ${JSON.stringify(key)}`);
      assert.equal(error.field, "apiKey");
      assert.ok(error instanceof BypassFastError);
    }
    assert.equal(construct("ak_live_valid"), undefined);
  });

  it("validates the base URL", () => {
    for (const baseUrl of [
      "http://example.com",
      "http://localhost.example.com",
      "https://user:pass@api.test",
      "https://api.test/?q=1",
      "https://api.test?",
      "https://api.test/#fragment",
      "ftp://api.test",
      "not a url",
      "/relative",
    ]) {
      const error = construct("key", { baseUrl });
      assert.ok(error instanceof ValidationError, baseUrl);
      assert.equal(error.field, "baseUrl");
    }
    for (const baseUrl of [
      "https://api.bypass.fast",
      "http://localhost:8080",
      "http://LOCALHOST",
      "http://127.0.0.1:9000",
      "http://127.10.20.30",
      "http://[::1]:9000",
      "http://[::ffff:127.0.0.1]",
    ]) {
      assert.equal(construct("key", { baseUrl }), undefined, baseUrl);
    }
  });

  it("keeps a base path prefix and strips trailing slashes", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { payload: "ok" }));
    const { client } = testClient(fetch, { baseUrl: "https://api.test/prefix//" });
    await client.kasada.cd(cdRequest);
    assert.equal(requests[0]?.url, "https://api.test/prefix/v1/solve/kasada");
  });

  it("validates retry, budget, compression, timeout and user agent options", () => {
    const bad: [BypassFastOptions, string][] = [
      [{ retry: { maxRetries: -1 } }, "retry.maxRetries"],
      [{ retry: { maxRetries: 11 } }, "retry.maxRetries"],
      [{ retry: { maxRetries: 1.5 } }, "retry.maxRetries"],
      [{ retry: { baseDelayMs: -1 } }, "retry.baseDelayMs"],
      [{ retry: { maxDelayMs: 2 * 3_600_000 } }, "retry.maxDelayMs"],
      [{ retry: { baseDelayMs: 1000, maxDelayMs: 0 } }, "retry.maxDelayMs"],
      [{ retry: { baseDelayMs: 9000, maxDelayMs: 8000 } }, "retry.baseDelayMs"],
      [{ solverBusyRetryBudgetMs: -1 }, "solverBusyRetryBudgetMs"],
      [{ solverBusyRetryBudgetMs: 2 * 3_600_000 }, "solverBusyRetryBudgetMs"],
      [{ compressionThreshold: 1.5 }, "compressionThreshold"],
      [{ timeoutMs: 0 }, "timeoutMs"],
      [{ perimeterxTimeoutMs: Number.POSITIVE_INFINITY }, "perimeterxTimeoutMs"],
      [{ userAgent: "" }, "userAgent"],
      [{ userAgent: "   " }, "userAgent"],
      [{ userAgent: "app/1\r\nX-Injected: 1" }, "userAgent"],
    ];
    for (const [options, field] of bad) {
      const error = construct("key", options);
      assert.ok(error instanceof ValidationError, JSON.stringify(options));
      assert.equal(error.field, field);
    }
    for (const options of [
      { retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 } },
      { retry: { maxRetries: 10 } },
      { solverBusyRetryBudgetMs: 0 },
      { compressionThreshold: -1 },
      { compressionThreshold: 0 },
    ] satisfies BypassFastOptions[]) {
      assert.equal(construct("key", options), undefined, JSON.stringify(options));
    }
  });
});

describe("request construction", () => {
  it("sends the key, accept headers, user agent and a buffered JSON body", async () => {
    const { fetch, requests } = fakeFetch(() =>
      reply(200, { cost: 0.002, payload: "cipher", user_agent: "ua-out", duration_ms: 12 }, {
        "X-Request-ID": "req-123",
        "X-BypassFast-Edge": "edge-v1",
        "Server-Timing": "solve;dur=12",
      }),
    );
    const { client } = testClient(fetch, { userAgent: "  checkout/1.0 " });
    const result = await client.kasada.sensor({ script: "p.js", ua: "ua-in", accept_language: "en-US" });

    const request = requests[0];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://api.test/v1/solve/kasada");
    assert.equal(request.redirect, "manual");
    assert.ok(request.body instanceof Uint8Array, "body must be fully buffered");
    assert.deepEqual(request.headers, {
      "x-api-key": "test-key",
      accept: "application/json",
      "accept-encoding": "gzip",
      "user-agent": `bypassfast-node/${VERSION} checkout/1.0`,
      "content-type": "application/json",
    });
    assert.deepEqual(request.json(), { mode: "sensor", script: "p.js", ua: "ua-in", accept_language: "en-US" });

    assert.equal(result.payload, "cipher");
    assert.equal(result.user_agent, "ua-out");
    assert.deepEqual(result.response, {
      statusCode: 200,
      requestId: "req-123",
      edge: "edge-v1",
      serverTiming: "solve;dur=12",
      attempts: 1,
    });
    // The metadata is non-enumerable: serializing a result reproduces the API body.
    assert.ok(!Object.keys(result).includes("response"));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      cost: 0.002,
      payload: "cipher",
      user_agent: "ua-out",
      duration_ms: 12,
    });
  });

  it("uses the bare SDK user agent by default and sends no idempotency header", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    await client.kasada.cd(cdRequest);
    assert.equal(requests[0]?.headers["user-agent"], `bypassfast-node/${VERSION}`);
    assert.ok(!Object.keys(requests[0]?.headers ?? {}).some((name) => name.includes("idempotency")));
  });

  it("gzip-compresses bodies at or above the threshold only when that saves bytes", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const large = { script: "var challenge = 1;".repeat(200), ua: "ua", accept_language: "en-US" };
    const medium = { script: "a".repeat(500), ua: "ua" };

    await testClient(fetch).client.kasada.sensor(large);
    assert.equal(requests[0]?.headers["content-encoding"], "gzip");
    assert.ok((requests[0]?.body?.length ?? 0) < 1024);
    assert.equal(requests[0]?.json()["accept_language"], "en-US");

    await testClient(fetch).client.kasada.sensor(medium);
    assert.equal(requests[1]?.headers["content-encoding"], undefined, "below the default 1024-byte threshold");

    await testClient(fetch, { compressionThreshold: 0 }).client.kasada.sensor(medium);
    assert.equal(requests[2]?.headers["content-encoding"], "gzip", "threshold 0 compresses every body");

    await testClient(fetch, { compressionThreshold: -1 }).client.kasada.sensor(large);
    assert.equal(requests[3]?.headers["content-encoding"], undefined, "a negative threshold disables compression");

    await testClient(fetch, { compressionThreshold: 0 }).client.akamai.cpt({ token: "", difficulty: 0 });
    assert.equal(requests[4]?.headers["content-encoding"], undefined, "gzip of a tiny body is larger, so raw is sent");
    assert.equal(requests[4]?.headers["content-type"], "application/json");
  });

  it("rejects bodies above the 1 MiB limit locally", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    const script = "x".repeat(MiB + 1);

    await assert.rejects(client.kasada.sensor({ script, ua: "ua" }), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.field, "request");
      assert.equal(error.message, "bypassfast: invalid request: encoded JSON exceeds the 1 MiB API limit");
      return true;
    });
    await assert.rejects(client.solve("kasada", { mode: "sensor", script }), ValidationError);
    await assert.rejects(client.solve("akamai", { mode: "sensor", script }), ValidationError);
    assert.equal(requests.length, 0);
  });

  it("allows 2 MiB for generic PerimeterX solves", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true }));
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const result = await client.solve("perimeterx", { mode: "holdcaptcha", blocked: { body: "x".repeat(1.5 * MiB) } });
    assert.equal(result.success, true);
    assert.ok((requests[0]?.body?.length ?? 0) > MiB);
    await assert.rejects(
      client.solve("perimeterx", { mode: "holdcaptcha", blocked: { body: "x".repeat(2 * MiB + 1) } }),
      /encoded JSON exceeds the 2 MiB API limit/,
    );
    assert.equal(requests.length, 1);
  });

  it("reports unencodable requests as validation errors", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    await assert.rejects(client.solve("kasada", cyclic), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.message, "bypassfast: invalid request: could not encode JSON");
      return true;
    });
    assert.equal(requests.length, 0);
  });
});

describe("response handling", () => {
  it("gunzips a body the fetch implementation left compressed", async () => {
    const body = gzipSync(JSON.stringify({ payload: "cipher", duration_ms: 3 }));
    const { fetch } = fakeFetch(() => new Response(body, { status: 200, headers: { "content-encoding": "gzip" } }));
    const result = await testClient(fetch).client.kasada.cd(cdRequest);
    assert.equal(result.payload, "cipher");
  });

  it("does not decode twice when fetch already gunzipped the body", async () => {
    const { fetch } = fakeFetch(() => reply(200, { payload: "plain" }, { "content-encoding": "gzip" }));
    const result = await testClient(fetch).client.kasada.cd(cdRequest);
    assert.equal(result.payload, "plain");
  });

  it("rejects unsupported encodings without retrying, for any status", async () => {
    const { fetch, requests } = fakeFetch(() => reply(503, { error: "solver_unavailable" }, { "content-encoding": "br" }));
    const { client } = testClient(fetch, { retry: { maxRetries: 2 } });
    await assert.rejects(client.kasada.cd(cdRequest), (error: unknown) => {
      assert.ok(error instanceof ResponseError);
      assert.equal(error.message, 'bypassfast: invalid response (status 503): unsupported response content encoding "br"');
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it("caps decoded responses at 4 MiB", async () => {
    const exact = JSON.stringify({ payload: "" });
    const fill = "y".repeat(4 * MiB - exact.length);
    const atLimit = JSON.stringify({ payload: fill });
    assert.equal(Buffer.byteLength(atLimit), 4 * MiB);
    const ok = await testClient(fakeFetch(() => reply(200, atLimit)).fetch).client.kasada.cd(cdRequest);
    assert.equal(ok.payload.length, fill.length);

    const tooLarge = JSON.stringify({ payload: fill + "y" });
    const bomb = gzipSync(JSON.stringify({ payload: "0".repeat(5 * MiB) }));
    for (const response of [
      () => reply(200, tooLarge),
      () => new Response(bomb, { status: 200, headers: { "content-encoding": "gzip" } }),
    ]) {
      const { client } = testClient(fakeFetch(response).fetch);
      await assert.rejects(client.kasada.cd(cdRequest), (error: unknown) => {
        assert.ok(error instanceof ResponseError);
        assert.match(error.message, /response exceeds 4194304 bytes$/);
        return true;
      });
    }
  });

  it("never exposes a malformed body in errors", async () => {
    const secret = "cookie-secret-must-not-appear";
    const { fetch } = fakeFetch(() => reply(200, `{"cookie":"${secret}")`, { "x-request-id": "req-malformed" }));
    const error = await testClient(fetch).client.kasada.cd(cdRequest).catch((caught: unknown) => caught);
    assert.ok(error instanceof ResponseError);
    assert.equal(error.response.requestId, "req-malformed");
    assert.equal(error.message, "bypassfast: invalid response (status 200, request req-malformed): response body is not valid JSON");
    assert.ok(!inspect(error, { depth: 5 }).includes(secret));
  });

  it("accepts empty and null 2xx bodies and rejects non-object JSON", async () => {
    for (const body of ["", "null"]) {
      const result = await testClient(fakeFetch(() => new Response(body, { status: 200 })).fetch).client.balance();
      assert.deepEqual({ ...result }, {});
      assert.equal(result.response.statusCode, 200);
    }
    for (const body of ["[1]", '"text"', "42", "true"]) {
      const { client } = testClient(fakeFetch(() => reply(200, body)).fetch);
      await assert.rejects(client.balance(), /response body is not a JSON object/);
    }
  });

  it("keeps fields this SDK version does not model", async () => {
    const { fetch } = fakeFetch(() => reply(200, { payload: "p", added_later: { a: 1 } }));
    const result = await testClient(fetch).client.kasada.cd(cdRequest);
    assert.deepEqual((result as unknown as Record<string, unknown>)["added_later"], { a: 1 });
  });

  it("returns a redirect as an APIError instead of following it", async () => {
    const { fetch, requests } = fakeFetch(() =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.test/steal" } }),
    );
    const { client } = testClient(fetch, { retry: { maxRetries: 2 } });
    await assert.rejects(client.kasada.cd(cdRequest), (error: unknown) => {
      assert.ok(error instanceof APIError);
      assert.equal(error.response.statusCode, 307);
      assert.equal(error.code, "http_error");
      assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.redirect, "manual");
  });
});

describe("balance and generic solve", () => {
  it("reads the balance with a bodiless GET", async () => {
    const { fetch, requests } = fakeFetch(() =>
      reply(200, { errorId: 0, org_id: "org_1", balance: 12.5, balance_cents: 1250, currency: "USD" }),
    );
    const balance = await testClient(fetch).client.balance();
    assert.equal(balance.balance_cents, 1250);
    assert.equal(balance.currency, "USD");
    assert.equal(balance.response.attempts, 1);
    const request = requests[0];
    assert.equal(request?.method, "GET");
    assert.equal(request?.url, "https://api.test/balance");
    assert.equal(request?.body, undefined);
    assert.equal(request?.headers["content-type"], undefined);
    assert.equal(request?.headers["content-encoding"], undefined);
  });

  it("posts a raw body to the named solver", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, answers: ["a"] }));
    const { client } = testClient(fetch);
    const result = await client.solve<{ success: boolean; answers: string[] }>("akamai", {
      mode: "cpt",
      token: "t",
      difficulty: 16,
    });
    assert.deepEqual(result.answers, ["a"]);
    assert.equal(result.response.attempts, 1);
    assert.equal(requests[0]?.url, "https://api.test/v1/solve/akamai");
    assert.deepEqual(requests[0]?.json(), { mode: "cpt", token: "t", difficulty: 16 });
  });

  it("rejects unknown solvers and non-object bodies locally", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    await assert.rejects(client.solve("../admin" as "akamai", {}), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.message, "bypassfast: invalid solver: must be akamai, kasada, incapsula, or perimeterx");
      return true;
    });
    await assert.rejects(client.solve("kasada", [] as object), ValidationError);
    await assert.rejects(client.solve("kasada", null as unknown as object), ValidationError);
    await assert.rejects(client.kasada.cd(null as never), /bypassfast: invalid request: must be an object/);
    assert.equal(requests.length, 0);
  });
});

describe("transport failures, timeouts and cancellation", () => {
  it("wraps network errors in RequestError and never retries them", async () => {
    const cause = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });
    const { fetch, requests } = fakeFetch(() => {
      throw cause;
    });
    const { client } = testClient(fetch, { retry: { maxRetries: 5 } });
    const error = await client.kasada.cd(cdRequest).catch((caught: unknown) => caught);
    assert.ok(error instanceof RequestError);
    assert.equal(error.operation, "POST /v1/solve/kasada");
    assert.equal(error.attempts, 1);
    assert.equal(error.cause, cause);
    assert.equal(error.message, "bypassfast: POST /v1/solve/kasada: fetch failed: connect ECONNREFUSED 127.0.0.1:1");
    assert.equal(requests.length, 1);
  });

  it("applies the per-attempt timeout, with a separate PerimeterX default", async () => {
    const { fetch } = fakeFetch(hang);
    const short = testClient(fetch, { timeoutMs: 20, perimeterxTimeoutMs: 60_000 }).client;
    await assert.rejects(short.kasada.cd(cdRequest), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal((error.cause as Error).name, "TimeoutError");
      return true;
    });

    const pxShort = testClient(fetch, { timeoutMs: 60_000, perimeterxTimeoutMs: 20 }).client;
    await assert.rejects(pxShort.perimeterx.init({ url: "https://www.example.com/", proxy: "http://u:p@proxy:1" }), RequestError);
    await assert.rejects(pxShort.solve("perimeterx", { mode: "init" }), RequestError);
  });

  it("rejects with the caller's abort reason during a request", async () => {
    const { fetch, requests } = fakeFetch(hang);
    const { client } = testClient(fetch);
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const pending = client.kasada.cd(cdRequest, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 5);
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(requests.length, 1);

    await assert.rejects(client.kasada.cd(cdRequest, { signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.equal(requests.length, 1, "an already-aborted signal sends nothing");
  });

  it("enforces a call deadline", async () => {
    const { fetch, requests } = fakeFetch(hang);
    const { client, clock } = testClient(fetch);
    await assert.rejects(client.kasada.cd(cdRequest, { deadline: clock.now - 1 }), { name: "TimeoutError" });
    assert.equal(requests.length, 0);
    await assert.rejects(client.kasada.cd(cdRequest, { deadline: new Date(clock.now + 20) }), (error: unknown) => {
      assert.ok(!(error instanceof BypassFastError), "a deadline is native cancellation, not a RequestError");
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    });
    await assert.rejects(client.kasada.cd(cdRequest, { deadline: Number.NaN }), ValidationError);
  });

  it("is safe for concurrent use", async () => {
    const { fetch, requests } = fakeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return reply(200, { payload: "ok", backend: "replay" });
    });
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const request = { script: "shared script", script_url: "https://www.example.com/loader.js", url: "https://www.example.com", ua: "ua" };
    const results = await Promise.all(Array.from({ length: 32 }, () => client.incapsula.reese84(request)));
    assert.equal(results.length, 32);
    assert.equal(requests.length, 32);
  });
});
