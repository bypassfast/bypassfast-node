/** Semantic version of this SDK; sent in the User-Agent header. */
export const VERSION = "0.1.0";

export const DEFAULT_BASE_URL = "https://api.bypass.fast";
export const DEFAULT_COMPRESSION_THRESHOLD = 1024;

const MiB = 1024 * 1024;
/** Encoded JSON limit for every route except PerimeterX. */
export const MAX_REQUEST_BYTES = 1 * MiB;
/** PerimeterX holdcaptcha bodies carry the customer's HTML block page; the edge allows 2 MiB there. */
export const MAX_PERIMETERX_REQUEST_BYTES = 2 * MiB;
/** Decoded response body limit. */
export const MAX_RESPONSE_BYTES = 4 * MiB;

export const MAX_CONFIGURED_RETRIES = 10;
/** Safety cap on every retry delay and server hint: one hour. */
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/** Per-attempt HTTP timeout (connect, headers and body), just beyond the edge's solver deadline. */
export const DEFAULT_TIMEOUT_MS = 65_000;
/** The edge allows 150 s for PerimeterX; holds take 15-50 s. */
export const DEFAULT_PERIMETERX_TIMEOUT_MS = 155_000;

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 8_000;

export const DEFAULT_SOLVER_BUSY_RETRY_BUDGET_MS = 45_000;
/** Minimum solver_busy wait when the response carries no hint. */
export const SOLVER_BUSY_RETRY_FLOOR_MS = 1_000;
/** Caps the jitter window of one solver_busy wait. */
export const SOLVER_BUSY_RETRY_MAX_DELAY_MS = 10_000;

export const SCRIPT_MEMORY_CAPACITY = 256;

/** Largest delay a Node timer accepts without overflowing. */
export const MAX_TIMER_MS = 2_147_483_647;
