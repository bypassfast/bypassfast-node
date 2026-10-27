import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "./errors.js";

/** A JSON object under construction; keys are emitted in insertion order. */
export type Wire = Record<string, unknown>;

/**
 * JSON.stringify that writes every bigint as a bare JSON number, so uint64
 * values such as Kasada seeds survive beyond 2^53.
 */
export function encodeJSON(value: unknown): string | undefined {
  const raw: string[] = [];
  const marker = `bypassfast-raw-${randomBytes(8).toString("hex")}-`;
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      raw.push(item.toString());
      return `${marker}${raw.length - 1}`;
    }
    return item;
  });
  if (text === undefined || raw.length === 0) {
    return text;
  }
  return text.replace(new RegExp(`"${marker}([0-9]+)"`, "g"), (_match, index: string) => raw[Number(index)] ?? "null");
}

/** Go's omitempty: "", false, 0, null/undefined, empty arrays and empty objects are left out. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false || value === 0 || value === 0n) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/** Sets a field the API always receives, substituting the zero value when unset. */
export function always(wire: Wire, key: string, value: unknown, zero: unknown): void {
  wire[key] = value ?? zero;
}

/** Sets a field only when it is non-empty. */
export function omitEmpty(wire: Wire, key: string, value: unknown): void {
  if (!isEmpty(value)) {
    wire[key] = value;
  }
}

const UINT64_MAX = 18446744073709551615n;

/** Normalizes a uint64 given as bigint, safe-integer number or decimal string. */
export function toUint64(field: string, value: bigint | number | string | null | undefined): bigint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let result: bigint | undefined;
  if (typeof value === "bigint") {
    result = value;
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      result = BigInt(value);
    }
  } else if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    result = BigInt(value);
  }
  if (result === undefined || result < 0n || result > UINT64_MAX) {
    throw new ValidationError(
      field,
      "must be an unsigned 64-bit integer (a bigint, a safe-integer number, or a decimal string)",
    );
  }
  return result;
}

/** Throws unless a typed method received an object. */
export function requireObject(request: unknown): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new ValidationError("request", "must be an object");
  }
}

/** UTF-8 bytes of a string, or the bytes themselves. */
export function toBytes(value: string | Uint8Array | null | undefined): Uint8Array {
  if (value === undefined || value === null) {
    return new Uint8Array(0);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new ValidationError("script", "must be a string or a Uint8Array");
}

/** Lower-case hex SHA-256. */
export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The `script_id` of a raw challenge script: the lower-case hex SHA-256 of its
 * bytes exactly as fetched (a string is encoded as UTF-8). The SDK computes it
 * for every script it sends; call it to persist an ID beside a cached script.
 */
export function scriptId(script: string | Uint8Array): string {
  return sha256Hex(toBytes(script));
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Reconciles an explicit `script_id` with the script bytes: the bytes decide
 * the ID, and an explicit ID that disagrees is a local validation error (the
 * API would answer 400 script_id_mismatch). Returns "" when neither is given.
 */
export function resolveScriptId(explicit: unknown, script: Uint8Array): string {
  const raw = explicit ?? "";
  if (typeof raw !== "string") {
    throw new ValidationError("script_id", "must be a string");
  }
  let id = raw.trim().toLowerCase();
  if (id !== "" && !SHA256_HEX.test(id)) {
    throw new ValidationError("script_id", "must be a 64-character SHA-256 hex digest");
  }
  if (script.length > 0) {
    const computed = sha256Hex(script);
    if (id !== "" && id !== computed) {
      throw new ValidationError("script_id", "does not match the script bytes");
    }
    id = computed;
  }
  return id;
}

/** Length of the standard base64 encoding of `n` bytes. */
export function base64Length(n: number): number {
  return Math.ceil(n / 3) * 4;
}

/** Standard base64 with padding. */
export function base64(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}
