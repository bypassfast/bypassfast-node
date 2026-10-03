import { gunzipSync } from "node:zlib";
import { kInternal, type InternalHooks } from "../src/core.js";
import { BypassFast, type BypassFastOptions, type FetchLike } from "../src/index.js";

/** One request the fake fetch received. */
export interface RecordedRequest {
  url: string;
  method: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Wire bytes exactly as passed to fetch. */
  body: Uint8Array | undefined;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | undefined;
  /** Body decoded (gunzipped when Content-Encoding is gzip) as text. */
  text(): string;
  /** Body decoded as JSON. */
  json(): Record<string, any>;
}

export type Handler = (request: RecordedRequest, index: number) => Response | Promise<Response>;

/** A fetch replacement that records each request and answers with `handler`. */
export function fakeFetch(handler: Handler): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const body = init.body === undefined || init.body === null ? undefined : (init.body as Uint8Array);
    const request: RecordedRequest = {
      url,
      method: init.method ?? "GET",
      headers,
      body,
      redirect: init.redirect,
      signal: init.signal ?? undefined,
      text() {
        if (body === undefined) {
          return "";
        }
        const bytes = headers["content-encoding"] === "gzip" ? gunzipSync(body) : Buffer.from(body);
        return bytes.toString("utf8");
      },
      json() {
        return JSON.parse(this.text()) as Record<string, any>;
      },
    };
    requests.push(request);
    return handler(request, requests.length - 1);
  };
  return { fetch, requests };
}

/** A JSON response; strings are sent verbatim. */
export function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * Rejects with the signal's reason when it aborts, like a fetch that never
 * answers. A real fetch holds an open socket; this holds a referenced timer,
 * because Node's AbortSignal.timeout timer alone does not keep the process alive.
 */
export function hang(request: RecordedRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = request.signal;
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const keepAlive = setInterval(() => undefined, 1000);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(keepAlive);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export interface FakeClock {
  /** Current time in epoch ms; sleeps advance it. */
  now: number;
  /** Every backoff wait the client requested, in ms. */
  sleeps: number[];
}

/**
 * A client wired to `fetch`, with retries off unless `options.retry` sets
 * them, an instant fake clock and zero jitter unless `hooks` override them.
 */
export function testClient(
  fetch: FetchLike,
  options: BypassFastOptions = {},
  hooks: InternalHooks = {},
): { client: BypassFast; clock: FakeClock } {
  const clock: FakeClock = { now: Date.UTC(2026, 9, 2, 12, 0, 0), sleeps: [] };
  const internal: InternalHooks = {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.now += ms;
    },
    jitter: () => 0,
    ...hooks,
  };
  const client = new BypassFast("test-key", {
    baseUrl: "https://api.test",
    fetch,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
    ...options,
    [kInternal]: internal,
  } as BypassFastOptions);
  return { client, clock };
}

/** A minimal valid Kasada CD request. */
export const cdRequest = {
  script: "p.js",
  st: 1,
  ct: "ct",
  domain: "www.example.com",
  work_time: 250,
  rst: 1,
  d: 10,
  id: "id",
  duration: 1.5,
  fc: "fc",
};
