import { randomInt } from "node:crypto";
import {
  MAX_RETRY_DELAY_MS,
  SOLVER_BUSY_RETRY_FLOOR_MS,
  SOLVER_BUSY_RETRY_MAX_DELAY_MS,
} from "./constants.js";
import type { APIErrorDetails } from "./errors.js";

/** Returns a delay in [0, ceilingMs]. */
export type Jitter = (ceilingMs: number) => number;

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Uniform integer in [0, ceilingMs] from the CSPRNG; ceilingMs / 2 if it fails. */
export function fullJitter(ceilingMs: number): number {
  if (!(ceilingMs > 0)) {
    return 0;
  }
  try {
    return randomInt(0, Math.floor(ceilingMs) + 1);
  } catch {
    return ceilingMs / 2;
  }
}

/** Exponential backoff with full jitter for the nth (1-based) ordinary retry; a larger hint wins. */
export function retryDelay(retry: number, retryAfterMs: number, policy: RetryPolicy, jitter: Jitter): number {
  let base = policy.baseDelayMs;
  if (retry > 1 && base > 0) {
    for (let i = 1; i < retry && base < policy.maxDelayMs; i++) {
      if (base > policy.maxDelayMs / 2) {
        base = policy.maxDelayMs;
        break;
      }
      base *= 2;
    }
  }
  if (policy.maxDelayMs > 0 && base > policy.maxDelayMs) {
    base = policy.maxDelayMs;
  }
  base = jitter(base);
  return retryAfterMs > base ? retryAfterMs : base;
}

/**
 * Wait before a call's nth solver_busy retry. The server hint is a floor that
 * is never undercut; above it a full-jitter window doubles per retry up to
 * 10 s (or twice the floor, when larger), so clients rejected together do not
 * return together. While the floor fits the remaining budget, the window is
 * narrowed to end inside it.
 */
export function solverBusyDelay(retry: number, retryAfterMs: number, remainingMs: number, jitter: Jitter): number {
  const floor = retryAfterMs > 0 ? retryAfterMs : SOLVER_BUSY_RETRY_FLOOR_MS;
  if (floor >= MAX_RETRY_DELAY_MS) {
    return MAX_RETRY_DELAY_MS;
  }
  const limit = Math.min(Math.max(SOLVER_BUSY_RETRY_MAX_DELAY_MS, 2 * floor), MAX_RETRY_DELAY_MS);
  let ceiling = floor;
  for (let i = 0; i < retry && ceiling < limit; i++) {
    ceiling *= 2;
  }
  ceiling = Math.min(ceiling, limit);
  if (remainingMs >= floor) {
    ceiling = Math.min(ceiling, remainingMs);
  }
  return floor + jitter(ceiling - floor);
}

/** Converts the optional `retry_after_ms` body field; anything but a positive finite number is 0. */
export function parseRetryAfterMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= MAX_RETRY_DELAY_MS ? MAX_RETRY_DELAY_MS : value;
}

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

/** Converts a Retry-After header (delta-seconds or HTTP-date) to ms; 0 for none. */
export function parseRetryAfterHeader(value: string | null | undefined, nowMs: number): number {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    return 0;
  }
  if (/^[+-]?[0-9]+$/.test(trimmed)) {
    const seconds = BigInt(trimmed);
    if (seconds >= INT64_MIN && seconds <= INT64_MAX) {
      if (seconds <= 0n) {
        return 0;
      }
      if (seconds >= BigInt(MAX_RETRY_DELAY_MS / 1000)) {
        return MAX_RETRY_DELAY_MS;
      }
      return Number(seconds) * 1000;
    }
  }
  const when = parseHttpDate(trimmed);
  if (when === undefined || !(when > nowMs)) {
    return 0;
  }
  return Math.min(when - nowMs, MAX_RETRY_DELAY_MS);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const LONG_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTH = `(${MONTHS.join("|")})`;
const CLOCK = "([0-9]{2}):([0-9]{2}):([0-9]{2})";
// IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
const IMF_FIXDATE = new RegExp(`^${DAY}, ([0-9]{2}) ${MONTH} ([0-9]{4}) ${CLOCK} GMT$`);
// RFC 850: Sunday, 06-Nov-94 08:49:37 GMT
const RFC_850 = new RegExp(`^${LONG_DAY}, ([0-9]{2})-${MONTH}-([0-9]{2}) ${CLOCK} [A-Z]{3,4}$`);
// asctime: Sun Nov  6 08:49:37 1994
const ASCTIME = new RegExp(`^${DAY} ${MONTH} ([ 0-9][0-9]) ${CLOCK} ([0-9]{4})$`);

/** Parses the three HTTP-date formats (RFC 9110 section 5.6.7) as UTC epoch ms. */
export function parseHttpDate(value: string): number | undefined {
  // [day, month, year, hour, minute, second]
  let parts: [string, string, number, string, string, string];
  let match: RegExpExecArray | null;
  if ((match = IMF_FIXDATE.exec(value)) !== null) {
    parts = [match[1], match[2], Number(match[3]), match[4], match[5], match[6]];
  } else if ((match = RFC_850.exec(value)) !== null) {
    const twoDigit = Number(match[3]);
    parts = [match[1], match[2], twoDigit >= 69 ? 1900 + twoDigit : 2000 + twoDigit, match[4], match[5], match[6]];
  } else if ((match = ASCTIME.exec(value)) !== null) {
    parts = [match[2], match[1], Number(match[6]), match[3], match[4], match[5]];
  } else {
    return undefined;
  }
  const [dayText, month, year, hourText, minuteText, secondText] = parts;
  const day = Number(dayText.trim());
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const ms = Date.UTC(year, MONTHS.indexOf(month), day, hour, minute, second);
  // Reject dates such as 31 Feb that Date.UTC would roll over.
  if (new Date(ms).getUTCDate() !== day) {
    return undefined;
  }
  return ms;
}

/**
 * Decodes a non-2xx body. If the body as a whole is not an object whose
 * error, error_code, message, stage and reason are strings (or absent), only
 * the code "http_error" survives. A malformed retry_after_ms never discards
 * the code.
 */
export function decodeAPIError(payload: Uint8Array): APIErrorDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"));
  } catch {
    return { code: "http_error" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { code: "http_error" };
  }
  const body = parsed as Record<string, unknown>;
  const strings: Record<string, string> = {};
  for (const key of ["error", "error_code", "message", "stage", "reason"]) {
    const value = body[key];
    if (value === undefined || value === null) {
      strings[key] = "";
    } else if (typeof value === "string") {
      strings[key] = value;
    } else {
      return { code: "http_error" };
    }
  }
  return {
    code: strings["error"] || strings["error_code"] || "http_error",
    message: strings["message"] ?? "",
    stage: strings["stage"] ?? "",
    reason: strings["reason"] ?? "",
    retryAfterMs: parseRetryAfterMs(body["retry_after_ms"]),
  };
}
