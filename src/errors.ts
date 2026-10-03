import type { ErrorCode, ResponseMeta } from "./types.js";

/** Base class of every error this SDK creates. */
export class BypassFastError extends Error {}

/** A request rejected locally, before any API call. */
export class ValidationError extends BypassFastError {
  /** The offending option or request field; empty for a general problem. */
  readonly field: string;
  /** What is wrong with it. */
  readonly detail: string;

  constructor(field: string, detail: string, options?: { cause?: unknown }) {
    super(field === "" ? `bypassfast: ${detail}` : `bypassfast: invalid ${field}: ${detail}`, options);
    this.field = field;
    this.detail = detail;
  }
}

/**
 * The request could not be sent or no response arrived, a per-attempt timeout
 * included. Never retried automatically: the solve may have completed (and
 * been billed) before the connection failed.
 */
export class RequestError extends BypassFastError {
  /** For example "POST /v1/solve/kasada". */
  readonly operation: string;
  /** HTTP attempts made by the call, this one included. */
  attempts: number;

  constructor(operation: string, cause: unknown, attempts: number) {
    super(`bypassfast: ${operation}: ${describeCause(cause)}`, { cause });
    this.operation = operation;
    this.attempts = attempts;
  }
}

/**
 * A response that could not be read or decoded: unsupported encoding, over
 * 4 MiB, or a 2xx body that is not a JSON object. Response bodies never appear
 * in the message because solver output contains bearer credentials.
 */
export class ResponseError extends BypassFastError {
  readonly response: ResponseMeta;

  constructor(response: ResponseMeta, cause: Error) {
    super(`bypassfast: invalid response (${statusText(response)}): ${cause.message}`, { cause });
    this.response = response;
  }
}

/** Fields decoded from a non-2xx response. */
export interface APIErrorDetails {
  code: string;
  message?: string;
  stage?: string;
  reason?: string;
  retryAfterMs?: number;
}

/**
 * A non-2xx response from Bypass Fast, 3xx included (redirects are never
 * followed). `code` is the stable machine contract.
 */
export class APIError extends BypassFastError {
  readonly response: ResponseMeta;
  /** `error` (or Akamai's legacy `error_code`) from the body; "http_error" when absent. */
  readonly code: ErrorCode | (string & {});
  /** Pipeline stage that failed, when the API names one. */
  readonly stage: string;
  /** Refines some codes, e.g. how the proxy failed for PerimeterX `proxy_error`. */
  readonly reason: string;
  /** Server retry hint in ms: `retry_after_ms` when positive, else `Retry-After`; 0 for none. */
  readonly retryAfterMs: number;
  readonly #apiMessage: string;

  constructor(response: ResponseMeta, details: APIErrorDetails) {
    const code = details.code === "" ? "http_error" : details.code;
    super(`bypassfast: ${code} (${statusText(response)})`);
    this.response = response;
    this.code = code;
    this.stage = details.stage ?? "";
    this.reason = details.reason ?? "";
    this.retryAfterMs = details.retryAfterMs ?? 0;
    this.#apiMessage = details.message ?? "";
  }

  /**
   * The human-readable `message` from the API. It is kept out of `.message`,
   * logs and inspection output because it can echo request inputs.
   */
  get apiMessage(): string {
    return this.#apiMessage;
  }

  /** Whether retrying this response is safe and recommended. */
  get retryable(): boolean {
    return isRetryable(this.code, this.response.statusCode);
  }
}

for (const [ctor, name] of [
  [BypassFastError, "BypassFastError"],
  [ValidationError, "ValidationError"],
  [RequestError, "RequestError"],
  [ResponseError, "ResponseError"],
  [APIError, "APIError"],
] as const) {
  Object.defineProperty(ctor.prototype, "name", { value: name, writable: true, configurable: true, enumerable: false });
}

const NOT_RETRYABLE = new Set([
  "quota_exceeded",
  "billing_disabled",
  "hard_block",
  "unsupported_challenge",
  "unsupported_script",
  "solve_failed",
  "not_verified",
  "solve_timeout",
  "script_cache_miss",
]);

const RETRYABLE = new Set([
  "solver_busy",
  "rate_limited",
  "quota_unavailable",
  "replay_unavailable",
  "edge_unavailable",
  "solver_unavailable",
  "api_key_store_unavailable",
  "org_status_unavailable",
  "cf_allowlist_unavailable",
  "request_cancelled",
  "internal",
  "internal_error",
  "no_devices_available",
  "device_unavailable",
  "script_cache_unavailable",
  "captcha_builder_unavailable",
  // The site or HUMAN failed to answer (424); a later attempt can succeed on the same exit.
  "target_error",
]);

function isRetryable(code: string, statusCode: number): boolean {
  // The customer's proxy or exit failed; the same request through the same
  // exit fails again. Switch exit instead of retrying.
  if (code === "proxy_error") {
    return false;
  }
  if (NOT_RETRYABLE.has(code)) {
    return false;
  }
  if (RETRYABLE.has(code)) {
    return true;
  }
  return statusCode >= 500 && statusCode <= 599;
}

/** Reports whether `error` is an APIError with the given machine code. */
export function isErrorCode(error: unknown, code: ErrorCode | (string & {})): error is APIError {
  return error instanceof APIError && error.code === code;
}

function statusText(response: ResponseMeta): string {
  return response.requestId === ""
    ? `status ${response.statusCode}`
    : `status ${response.statusCode}, request ${response.requestId}`;
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }
  let text = cause.message || cause.name;
  // undici reports every network failure as "fetch failed" with the useful
  // detail (ECONNREFUSED, ENOTFOUND, ...) in its cause.
  const inner: unknown = cause.cause;
  if (inner instanceof Error && inner.message !== "" && !text.includes(inner.message)) {
    text += `: ${inner.message}`;
  }
  return text;
}
