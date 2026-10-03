import { isIPv4, isIPv6 } from "node:net";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_BASE_URL,
  DEFAULT_COMPRESSION_THRESHOLD,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_PERIMETERX_TIMEOUT_MS,
  DEFAULT_SOLVER_BUSY_RETRY_BUDGET_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_CONFIGURED_RETRIES,
  MAX_PERIMETERX_REQUEST_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_DELAY_MS,
  MAX_TIMER_MS,
  SCRIPT_MEMORY_CAPACITY,
  VERSION,
} from "./constants.js";
import { APIError, RequestError, ResponseError, ValidationError } from "./errors.js";
import {
  decodeAPIError,
  fullJitter,
  parseRetryAfterHeader,
  retryDelay,
  solverBusyDelay,
  type Jitter,
  type RetryPolicy,
} from "./retry.js";
import { ScriptMemory } from "./script-memory.js";
import type { BypassFastOptions, FetchLike, RequestOptions, ResponseMeta, Solver } from "./types.js";
import { encodeJSON } from "./wire.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Test hooks, passed under this symbol in the client options. Not part of the
 * public API.
 */
export const kInternal: unique symbol = Symbol.for("bypassfast.internal") as never;

export interface InternalHooks {
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  now?: () => number;
  jitter?: Jitter;
}

interface Config {
  apiKey: string;
  baseUrl: string;
  fetch: FetchLike;
  timeoutMs: number;
  perimeterxTimeoutMs: number;
  retry: RetryPolicy;
  solverBusyRetryBudgetMs: number;
  compressionThreshold: number;
  userAgent: string;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  now: () => number;
  jitter: Jitter;
}

/** State shared by the HTTP attempts of one public method call. */
export interface Call {
  /** Caller signal combined with the deadline; aborts end the call with its reason. */
  readonly signal: AbortSignal | undefined;
  /** Deadline on the `now()` clock, in ms. */
  readonly deadline: number | undefined;
}

interface Exchange {
  meta: ResponseMeta;
  payload: Uint8Array;
}

/** Transport, retry engine and script memory shared by one client's services. */
export class Core {
  readonly scripts = new ScriptMemory(SCRIPT_MEMORY_CAPACITY);
  readonly #config: Config;

  constructor(apiKey: string, options: BypassFastOptions | undefined) {
    this.#config = resolveConfig(apiKey, options);
  }

  /** Runs one public method call with its cancellation scope. */
  async run<T>(options: RequestOptions | undefined, body: (call: Call) => Promise<T>): Promise<T> {
    const { call, release } = this.#beginCall(options);
    try {
      return await body(call);
    } finally {
      release();
    }
  }

  /** POSTs a solve and returns the decoded JSON object. */
  solve(solver: Solver, wire: unknown, call: Call): Promise<{ meta: ResponseMeta; data: Record<string, unknown> }> {
    const perimeterx = solver === "perimeterx";
    return this.send(
      "POST",
      `/v1/solve/${solver}`,
      wire,
      perimeterx ? MAX_PERIMETERX_REQUEST_BYTES : MAX_REQUEST_BYTES,
      perimeterx ? this.#config.perimeterxTimeoutMs : this.#config.timeoutMs,
      call,
    );
  }

  /** GETs an endpoint without a body. */
  get(path: string, call: Call): Promise<{ meta: ResponseMeta; data: Record<string, unknown> }> {
    return this.send("GET", path, undefined, MAX_REQUEST_BYTES, this.#config.timeoutMs, call);
  }

  async send(
    method: "GET" | "POST",
    path: string,
    request: unknown,
    limit: number,
    timeoutMs: number,
    call: Call,
  ): Promise<{ meta: ResponseMeta; data: Record<string, unknown> }> {
    let body: Uint8Array | undefined;
    let encoding: string | undefined;
    if (request !== undefined) {
      ({ body, encoding } = await this.#encodeRequest(request, limit));
    }
    const { meta, payload } = await this.#execute(method, path, body, encoding, timeoutMs, call);
    return { meta, data: parseObject(meta, payload) };
  }

  #beginCall(options: RequestOptions | undefined): { call: Call; release: () => void } {
    if (options !== undefined && (options === null || typeof options !== "object")) {
      throw new ValidationError("options", "must be an object");
    }
    const signal = options?.signal;
    if (signal !== undefined && (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean")) {
      throw new ValidationError("signal", "must be an AbortSignal");
    }
    throwIfAborted(signal);
    let deadline: number | undefined;
    const sources: (AbortSignal | undefined)[] = [signal];
    if (options?.deadline !== undefined) {
      deadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
      if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
        throw new ValidationError("deadline", "must be a Date or a finite number of epoch milliseconds");
      }
      const remaining = deadline - this.#config.now();
      if (remaining <= 0) {
        throw timeoutReason();
      }
      if (remaining <= MAX_TIMER_MS) {
        sources.push(AbortSignal.timeout(Math.ceil(remaining)));
      }
    }
    const combined = combineSignals(sources);
    return { call: { signal: combined.signal, deadline }, release: combined.release };
  }

  async #encodeRequest(request: unknown, limit: number): Promise<{ body: Uint8Array; encoding?: string }> {
    let text: string | undefined;
    try {
      text = encodeJSON(request);
    } catch (error) {
      throw new ValidationError("request", "could not encode JSON", { cause: error });
    }
    if (text === undefined) {
      throw new ValidationError("request", "could not encode JSON");
    }
    const payload = Buffer.from(text, "utf8");
    if (payload.length > limit) {
      throw new ValidationError("request", `encoded JSON exceeds the ${limit / (1024 * 1024)} MiB API limit`);
    }
    const threshold = this.#config.compressionThreshold;
    if (payload.length === 0 || threshold < 0 || payload.length < threshold) {
      return { body: payload };
    }
    let compressed: Buffer;
    try {
      compressed = await gzipAsync(payload, { level: 1 });
    } catch {
      return { body: payload };
    }
    // Compression only helps when it saves bytes; the edge applies the same
    // cap to wire and decoded bodies.
    if (compressed.length >= payload.length || compressed.length > limit) {
      return { body: payload };
    }
    return { body: compressed, encoding: "gzip" };
  }

  async #execute(
    method: "GET" | "POST",
    path: string,
    body: Uint8Array | undefined,
    encoding: string | undefined,
    timeoutMs: number,
    call: Call,
  ): Promise<Exchange> {
    const config = this.#config;
    const started = config.now();
    let retries = 0;
    let busyRetries = 0;
    for (let attempt = 1; ; attempt++) {
      let delay: number;
      try {
        return await this.#attempt(method, path, body, encoding, timeoutMs, attempt, call);
      } catch (error) {
        if (!(error instanceof APIError) || !error.retryable) {
          throw error;
        }
        if (error.code === "solver_busy") {
          // Capacity rejects are retried against a time budget: slots free up
          // as solves finish or the fleet scales, and a short synchronized
          // burst would only deepen the overload.
          busyRetries++;
          const elapsed = config.now() - started;
          delay = solverBusyDelay(busyRetries, error.retryAfterMs, config.solverBusyRetryBudgetMs - elapsed, config.jitter);
          if (!this.#solverBusyRetryFits(elapsed, delay, call.deadline)) {
            throw error;
          }
        } else {
          if (retries >= config.retry.maxRetries) {
            throw error;
          }
          // Internal errors are documented for one retry; a broken solver
          // release should not cost three identical expensive attempts.
          if (retries >= 1 && (error.code === "internal" || error.code === "internal_error")) {
            throw error;
          }
          retries++;
          delay = retryDelay(retries, error.retryAfterMs, config.retry, config.jitter);
        }
      }
      if (delay > 0) {
        await config.sleep(delay, call.signal);
      }
    }
  }

  #solverBusyRetryFits(elapsed: number, delay: number, deadline: number | undefined): boolean {
    const config = this.#config;
    if (config.retry.maxRetries === 0 || config.solverBusyRetryBudgetMs <= 0) {
      return false;
    }
    if (elapsed + delay > config.solverBusyRetryBudgetMs) {
      return false;
    }
    return deadline === undefined || config.now() + delay < deadline;
  }

  async #attempt(
    method: "GET" | "POST",
    path: string,
    body: Uint8Array | undefined,
    encoding: string | undefined,
    timeoutMs: number,
    attempt: number,
    call: Call,
  ): Promise<Exchange> {
    throwIfAborted(call.signal);
    const config = this.#config;
    const headers: Record<string, string> = {
      "X-API-Key": config.apiKey,
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "User-Agent": config.userAgent,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      if (encoding !== undefined) {
        headers["Content-Encoding"] = encoding;
      }
    }
    const scope = combineSignals([call.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      let response: Response;
      try {
        // A fully buffered body makes fetch send Content-Length (the edge
        // answers 411 to chunked bodies). Redirects are never followed, so
        // X-API-Key cannot reach another origin.
        response = await config.fetch(config.baseUrl + path, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: scope.signal,
        });
      } catch (error) {
        throwIfAborted(call.signal);
        throw new RequestError(`${method} ${path}`, error, attempt);
      }
      const meta: ResponseMeta = {
        statusCode: response.status,
        requestId: response.headers.get("x-request-id") ?? "",
        edge: response.headers.get("x-bypassfast-edge") ?? "",
        serverTiming: response.headers.get("server-timing") ?? "",
        attempts: attempt,
      };
      let payload: Uint8Array;
      try {
        payload = await readResponse(response);
      } catch (error) {
        throwIfAborted(call.signal);
        throw new ResponseError(meta, error instanceof Error ? error : new Error(String(error)));
      }
      if (response.status >= 200 && response.status < 300) {
        return { meta, payload };
      }
      const details = decodeAPIError(payload);
      // retry_after_ms is the millisecond form of Retry-After and wins when
      // positive; older servers send only the header.
      if (!((details.retryAfterMs ?? 0) > 0)) {
        details.retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"), config.now());
      }
      throw new APIError(meta, details);
    } finally {
      scope.release();
    }
  }
}

function resolveConfig(apiKey: string, options: BypassFastOptions | undefined): Config {
  if (typeof apiKey !== "string" || apiKey === "") {
    throw new ValidationError("apiKey", "must not be empty");
  }
  if (apiKey.trim() !== apiKey || /[\r\n]/.test(apiKey)) {
    throw new ValidationError("apiKey", "must not contain surrounding or control whitespace");
  }
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new ValidationError("options", "must be an object");
  }
  const opts: BypassFastOptions = options ?? {};
  const hooks = ((opts as Record<symbol, unknown>)[kInternal] ?? {}) as InternalHooks;

  let fetchImpl: FetchLike;
  if (opts.fetch !== undefined) {
    if (typeof opts.fetch !== "function") {
      throw new ValidationError("fetch", "must be a function");
    }
    fetchImpl = opts.fetch;
  } else {
    if (typeof globalThis.fetch !== "function") {
      throw new ValidationError("fetch", "no global fetch; use Node.js 18.17 or newer, or pass options.fetch");
    }
    fetchImpl = (url, init) => globalThis.fetch(url, init);
  }

  const retry: RetryPolicy = {
    maxRetries: opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: opts.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: opts.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };
  if (!Number.isInteger(retry.maxRetries) || retry.maxRetries < 0 || retry.maxRetries > MAX_CONFIGURED_RETRIES) {
    throw new ValidationError("retry.maxRetries", `must be an integer between 0 and ${MAX_CONFIGURED_RETRIES}`);
  }
  for (const key of ["baseDelayMs", "maxDelayMs"] as const) {
    const value = retry[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_RETRY_DELAY_MS) {
      throw new ValidationError(`retry.${key}`, `must be between 0 and ${MAX_RETRY_DELAY_MS} ms`);
    }
  }
  if (retry.baseDelayMs > 0 && retry.maxDelayMs === 0) {
    throw new ValidationError("retry.maxDelayMs", "must be positive when baseDelayMs is positive");
  }
  if (retry.maxDelayMs > 0 && retry.baseDelayMs > retry.maxDelayMs) {
    throw new ValidationError("retry.baseDelayMs", "must not exceed maxDelayMs");
  }

  const budget = opts.solverBusyRetryBudgetMs ?? DEFAULT_SOLVER_BUSY_RETRY_BUDGET_MS;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0 || budget > MAX_RETRY_DELAY_MS) {
    throw new ValidationError("solverBusyRetryBudgetMs", `must be between 0 and ${MAX_RETRY_DELAY_MS} ms`);
  }

  const compressionThreshold = opts.compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD;
  if (!Number.isInteger(compressionThreshold)) {
    throw new ValidationError("compressionThreshold", "must be an integer (negative disables compression)");
  }

  const timeoutMs = checkTimeout("timeoutMs", opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const perimeterxTimeoutMs = checkTimeout("perimeterxTimeoutMs", opts.perimeterxTimeoutMs ?? DEFAULT_PERIMETERX_TIMEOUT_MS);

  let userAgent = `bypassfast-node/${VERSION}`;
  if (opts.userAgent !== undefined) {
    const application = typeof opts.userAgent === "string" ? opts.userAgent.trim() : "";
    if (application === "" || /[\r\n]/.test(application)) {
      throw new ValidationError("userAgent", "must be a non-empty single-line string");
    }
    userAgent += ` ${application}`;
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL),
    fetch: fetchImpl,
    timeoutMs,
    perimeterxTimeoutMs,
    retry,
    solverBusyRetryBudgetMs: budget,
    compressionThreshold,
    userAgent,
    sleep: hooks.sleep ?? sleep,
    now: hooks.now ?? Date.now,
    jitter: hooks.jitter ?? fullJitter,
  };
}

function checkTimeout(field: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new ValidationError(field, `must be a positive number of milliseconds up to ${MAX_TIMER_MS}`);
  }
  return value;
}

/** Validates the API origin and strips trailing slashes from its path. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("baseUrl", "must be an absolute HTTP(S) URL");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
    throw new ValidationError("baseUrl", "must be an absolute HTTP(S) URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) {
    throw new ValidationError("baseUrl", "must not contain credentials, query, or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ValidationError("baseUrl", "must use HTTPS unless the host is loopback");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** localhost, 127.0.0.0/8, ::1 and IPv4-mapped 127.0.0.0/8. */
export function isLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "localhost") {
    return true;
  }
  if (isIPv4(host)) {
    return host.startsWith("127.");
  }
  if (!isIPv6(host)) {
    return false;
  }
  if (host === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(host)) {
    return true;
  }
  const dotted = /^::ffff:([0-9.]+)$/.exec(host);
  if (dotted !== null) {
    return isIPv4(dotted[1]) && dotted[1].startsWith("127.");
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  return hex !== null && parseInt(hex[1], 16) >> 8 === 127;
}

/** Decodes a 2xx body: empty or `null` is an empty object; anything but an object is an error. */
function parseObject(meta: ResponseMeta, payload: Uint8Array): Record<string, unknown> {
  if (payload.length === 0) {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"));
  } catch {
    // The SyntaxError text quotes the body, which can hold credentials.
    throw new ResponseError(meta, new Error("response body is not valid JSON"));
  }
  if (value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ResponseError(meta, new Error("response body is not a JSON object"));
  }
  return value as Record<string, unknown>;
}

async function readResponse(response: Response): Promise<Uint8Array> {
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity" && encoding !== "gzip") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`unsupported response content encoding ${JSON.stringify(encoding)}`);
  }
  let bytes = await readBody(response, MAX_RESPONSE_BYTES);
  // Node's fetch already decodes gzip; an injected fetch may not. Decoded JSON
  // never starts with the gzip magic bytes, so this cannot decode twice.
  if (encoding === "gzip" && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (bytes.length > MAX_RESPONSE_BYTES) {
      throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    try {
      bytes = await gunzipAsync(bytes, { maxOutputLength: MAX_RESPONSE_BYTES + 1 });
    } catch (error) {
      if (error instanceof RangeError || (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      throw new Error(`decode gzip response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return bytes;
}

/** Reads at most limit + 1 bytes, then stops. */
async function readBody(response: Response, limit: number): Promise<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    throw new Error(`read response: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.concat(chunks, total);
}

/** Adds the attempts of an earlier call (a script-cache fallback) to a result or error. */
export function addPriorAttempts(error: unknown, prior: number): void {
  if (error instanceof APIError || error instanceof ResponseError) {
    error.response.attempts += prior;
  } else if (error instanceof RequestError) {
    error.attempts += prior;
  }
}

/** Attaches the call diagnostics as a non-enumerable `response` property. */
export function withResponse<T>(data: Record<string, unknown>, meta: ResponseMeta): T {
  Object.defineProperty(data, "response", { value: meta, enumerable: false, writable: false, configurable: true });
  return data as T;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
  }
}

function timeoutReason(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** AbortSignal.any where available (Node 18.17+), with a listener-based fallback for other runtimes. */
export function combineSignals(sources: (AbortSignal | undefined)[]): { signal: AbortSignal | undefined; release: () => void } {
  const signals = sources.filter((signal): signal is AbortSignal => signal !== undefined);
  if (signals.length === 0) {
    return { signal: undefined, release: noop };
  }
  if (signals.length === 1) {
    return { signal: signals[0], release: noop };
  }
  const any = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") {
    return { signal: any.call(AbortSignal, signals), release: noop };
  }
  return combineSignalsFallback(signals);
}

export function combineSignalsFallback(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const listeners: [AbortSignal, () => void][] = [];
  const release = (): void => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (signal.aborted) {
      release();
      controller.abort(signal.reason);
      return { signal: controller.signal, release: noop };
    }
    const listener = (): void => {
      release();
      controller.abort(signal.reason);
    };
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }
  return { signal: controller.signal, release };
}

function noop(): void {}

/** Waits `ms`, rejecting with the signal's reason if it aborts first. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
