/**
 * Least-recently-used map from cache keys to script SHA-256 digests. It
 * remembers only hashes, never script bodies, tokens, cookies or device data.
 */
export class ScriptMemory {
  readonly capacity: number;
  readonly #entries = new Map<string, string>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** True when `key` holds exactly `value`; a hit becomes the most recently used entry. */
  matches(key: string, value: string): boolean {
    const stored = this.#entries.get(key);
    if (stored === undefined || value === "" || stored !== value) {
      return false;
    }
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return true;
  }

  /** Stores `value` as the most recently used entry, evicting the least recently used one when full. */
  put(key: string, value: string): void {
    if (key === "" || value === "") {
      return;
    }
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    } else if (this.#entries.size >= this.capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, value);
  }

  /** Whether `key` is present, without touching recency. */
  has(key: string): boolean {
    return this.#entries.has(key);
  }
}
