/**
 * Which script digests the API recently answered with `script_cache_miss`.
 *
 * Every script-bearing call travels hash-first. After one miss the client
 * sends the script body straight away for the same digest, so a burst of
 * solves for a brand-new script costs one extra round trip rather than one
 * per call; a successful script-bearing call registers the script and forgets
 * the miss. It remembers only digests and timestamps, never script bodies,
 * tokens, cookies or device data.
 */
export class ScriptMemory {
  readonly capacity: number;
  readonly ttlMs: number;
  readonly #now: () => number;
  readonly #missed = new Map<string, number>();

  constructor(capacity: number, now: () => number, ttlMs: number) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.#now = now;
  }

  get size(): number {
    return this.#missed.size;
  }

  /** True when the API answered `script_cache_miss` for `key` within the memory window. */
  recentlyMissed(key: string): boolean {
    if (key === "") {
      return false;
    }
    const missedAt = this.#missed.get(key);
    if (missedAt === undefined) {
      return false;
    }
    if (this.#now() - missedAt >= this.ttlMs) {
      this.#missed.delete(key);
      return false;
    }
    return true;
  }

  /** Records that the API has no script for `key`. */
  markMissed(key: string): void {
    if (key === "") {
      return;
    }
    if (this.#missed.has(key)) {
      this.#missed.delete(key);
    } else if (this.#missed.size >= this.capacity) {
      const oldest = this.#missed.keys().next();
      if (oldest.done !== true) {
        this.#missed.delete(oldest.value);
      }
    }
    this.#missed.set(key, this.#now());
  }

  /** Forgets a miss: a script-bearing call for `key` succeeded. */
  markRegistered(key: string): void {
    this.#missed.delete(key);
  }

  /** Whether a miss for `key` is recorded, expired or not. */
  has(key: string): boolean {
    return this.#missed.has(key);
  }
}
