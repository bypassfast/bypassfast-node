/** Value-free diagnostics for one API call. */
export interface ResponseMeta {
  /** HTTP status of the final attempt; 0 when no response was received. */
  statusCode: number;
  /** X-Request-ID header; quote it to support. Empty when absent. */
  requestId: string;
  /** X-BypassFast-Edge header. Empty when absent. */
  edge: string;
  /** Server-Timing header. Empty when absent. */
  serverTiming: string;
  /** HTTP attempts made, retries and script-cache fallbacks included (1-based). */
  attempts: number;
}

/** Per-call options accepted by every method. */
export interface RequestOptions {
  /**
   * Cancels the call, whether a request is in flight or the client is waiting
   * to retry. The promise then rejects with `signal.reason` (an `AbortError`
   * DOMException unless you passed your own reason to `abort()`).
   */
  signal?: AbortSignal;
  /**
   * Absolute deadline for the whole call, retries included, as a Date or epoch
   * milliseconds. Reaching it rejects with a `TimeoutError` DOMException. A
   * `solver_busy` retry that could not start before the deadline is not
   * attempted: the call rejects with the `solver_busy` APIError instead.
   */
  deadline?: Date | number;
}

/** A solver accepted by `POST /v1/solve/{solver}`. */
export type Solver = "akamai" | "kasada" | "incapsula" | "perimeterx";

/**
 * Stable machine codes the API documents. `APIError.code` may also carry codes
 * added after this SDK version.
 */
export type ErrorCode =
  // transport
  | "bad_request"
  | "invalid_gzip_body"
  | "invalid_zstd_body"
  | "payload_too_large"
  | "unsupported_content_encoding"
  | "solver_busy"
  | "internal_error"
  // edge
  | "bad_content_length"
  | "invalid_json"
  | "target_url_required"
  | "missing_api_key"
  | "invalid_api_key"
  | "insufficient_scope"
  | "domain_not_allowed"
  | "not_found"
  | "solver_not_available"
  | "method_not_allowed"
  | "length_required"
  | "solver_unavailable"
  | "edge_unavailable"
  // admission
  | "org_suspended"
  | "quota_exceeded"
  | "rate_limited"
  | "quota_unavailable"
  | "replay_unavailable"
  | "api_key_store_unavailable"
  | "org_status_unavailable"
  | "cf_allowlist_unavailable"
  // akamai
  | "invalid_mode"
  | "missing_token"
  | "invalid_difficulty"
  | "script_mode_mismatch"
  | "script_cache_miss"
  | "script_too_large"
  | "unsupported_script"
  | "request_cancelled"
  | "device_unavailable"
  | "script_cache_unavailable"
  // kasada
  | "invalid_body"
  | "missing_user_agent"
  | "unsupported_user_agent"
  | "invalid_session"
  | "payload_incomplete"
  | "internal"
  | "no_devices_available"
  // incapsula
  | "invalid_url"
  | "invalid_script_url"
  | "invalid_ip"
  | "invalid_old_token"
  | "invalid_pow"
  | "missing_script"
  | "missing_session_ids"
  | "invalid_session_ids"
  | "unsupported_challenge"
  // perimeterx
  | "invalid_proxy"
  | "session_invalid"
  | "session_expired"
  | "unsupported_app_id"
  | "unsupported_build"
  | "not_challenged"
  | "hard_block"
  | "proxy_error"
  | "target_error"
  // synthesized by the SDK when a non-2xx body carries no code
  | "http_error";

/** `fetch`-compatible function; the global `fetch` is used by default. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Automatic retry policy for explicit, retryable API errors. */
export interface RetryOptions {
  /**
   * Retries after the first attempt, 0 to 10 (default 2). `solver_busy` is
   * retried against `solverBusyRetryBudgetMs` instead and does not count.
   * 0 disables every automatic retry, `solver_busy` included.
   */
  maxRetries?: number;
  /** Initial exponential-backoff ceiling in ms (default 500). */
  baseDelayMs?: number;
  /** Backoff cap in ms (default 8000). A server hint may exceed it, up to one hour. */
  maxDelayMs?: number;
}

/** Client options. Every field is optional. */
export interface BypassFastOptions {
  /** API origin (default https://api.bypass.fast). HTTPS unless the host is loopback. */
  baseUrl?: string;
  /** Replaces the global `fetch`, for example in tests. */
  fetch?: FetchLike;
  /** Per-attempt timeout in ms for every route except PerimeterX (default 65000). */
  timeoutMs?: number;
  /** Per-attempt timeout in ms for PerimeterX (default 155000). */
  perimeterxTimeoutMs?: number;
  /** Retry policy; unset fields keep their defaults. */
  retry?: RetryOptions;
  /**
   * How long, from the start of a call, `429 solver_busy` responses are
   * retried (default 45000 ms, at most one hour). 0 disables those retries.
   */
  solverBusyRetryBudgetMs?: number;
  /**
   * Request bodies of at least this many bytes are gzip-compressed when that
   * saves bytes (default 1024). Negative disables; 0 compresses every body.
   */
  compressionThreshold?: number;
  /** Application identifier appended to the SDK User-Agent, e.g. "checkout/2.4.0". */
  userAgent?: string;
}
