import { withResponse, type Core } from "./core.js";
import type { RequestOptions, ResponseMeta } from "./types.js";
import { always, omitEmpty, requireObject, toUint64, type Wire } from "./wire.js";

/** An unsigned 64-bit integer; sent as a bare JSON number. Use bigint or a decimal string above 2^53. */
export type Uint64 = bigint | number | string;

/** `mode: "sensor"`: a full Kasada payload. `script` is the raw p.js text, not base64. */
export interface KasadaSensorRequest {
  script: string;
  /** Chrome on Windows or macOS. */
  ua: string;
  session?: string;
  script_url?: string;
  url?: string;
  page_origin?: string;
  href?: string;
  window_url?: string;
  referrer?: string;
  ancestor_origins?: string[];
  runtime_overrides?: Record<string, unknown>;
  accept_language?: string;
  timezone?: string;
  ip?: string;
  challenge_token?: string;
  script_name?: string;
  seed?: Uint64;
  force_pool_variation?: boolean;
  now_ms?: number;
  dt?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface KasadaSensorResponse {
  cost: number;
  payload: string;
  /** Attach every one of these headers to the target exchange. */
  headers?: Record<string, string>;
  warnings?: string[];
  device_id: string;
  session: string;
  /** The exact User-Agent to send to the target. */
  user_agent: string;
  cache_hit: boolean;
  duration_ms: number;
  readonly response: ResponseMeta;
}

/** `mode: "cd"`: the follow-up CD proof of work. */
export interface KasadaCDRequest {
  script: string;
  st: number;
  ct: string;
  domain: string;
  work_time: number;
  rst: number;
  d: number;
  id: string;
  duration: number;
  fc: string;
  difficulty?: number;
  subchallenge_count?: number;
  seed_suffix?: string;
  extra_token?: string;
  is_mobile?: boolean;
  seed?: Uint64;
  now_ms?: number;
}

export interface KasadaCDResponse {
  cost: number;
  /** JSON string to send as x-kpsdk-cd. */
  payload: string;
  duration_ms: number;
  readonly response: ResponseMeta;
}

/** Kasada: sensor payloads and CD proofs of work. Scripts are never cached by the SDK. */
export class KasadaService {
  readonly #core: Core;

  /** @internal Use `client.kasada`. */
  constructor(core: Core) {
    this.#core = core;
  }

  /** Generates a Kasada sensor payload and x-kpsdk-* headers. */
  sensor(request: KasadaSensorRequest, options?: RequestOptions): Promise<KasadaSensorResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      const seed = toUint64("seed", request.seed);
      const wire: Wire = { mode: "sensor" };
      always(wire, "script", request.script, "");
      always(wire, "ua", request.ua, "");
      omitEmpty(wire, "session", request.session);
      omitEmpty(wire, "script_url", request.script_url);
      omitEmpty(wire, "url", request.url);
      omitEmpty(wire, "page_origin", request.page_origin);
      omitEmpty(wire, "href", request.href);
      omitEmpty(wire, "window_url", request.window_url);
      omitEmpty(wire, "referrer", request.referrer);
      omitEmpty(wire, "ancestor_origins", request.ancestor_origins);
      omitEmpty(wire, "runtime_overrides", request.runtime_overrides);
      omitEmpty(wire, "accept_language", request.accept_language);
      omitEmpty(wire, "timezone", request.timezone);
      omitEmpty(wire, "ip", request.ip);
      omitEmpty(wire, "challenge_token", request.challenge_token);
      omitEmpty(wire, "script_name", request.script_name);
      omitEmpty(wire, "seed", seed);
      omitEmpty(wire, "force_pool_variation", request.force_pool_variation);
      omitEmpty(wire, "now_ms", request.now_ms);
      omitEmpty(wire, "dt", request.dt);
      omitEmpty(wire, "headers", request.headers);
      const { meta, data } = await this.#core.solve("kasada", wire, call);
      return withResponse<KasadaSensorResponse>(data, meta);
    });
  }

  /** Solves a Kasada CD proof-of-work challenge. */
  cd(request: KasadaCDRequest, options?: RequestOptions): Promise<KasadaCDResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      const seed = toUint64("seed", request.seed);
      const wire: Wire = { mode: "cd" };
      always(wire, "script", request.script, "");
      always(wire, "st", request.st, 0);
      always(wire, "ct", request.ct, "");
      always(wire, "domain", request.domain, "");
      always(wire, "work_time", request.work_time, 0);
      always(wire, "rst", request.rst, 0);
      always(wire, "d", request.d, 0);
      always(wire, "id", request.id, "");
      always(wire, "duration", request.duration, 0);
      always(wire, "fc", request.fc, "");
      omitEmpty(wire, "difficulty", request.difficulty);
      omitEmpty(wire, "subchallenge_count", request.subchallenge_count);
      omitEmpty(wire, "seed_suffix", request.seed_suffix);
      omitEmpty(wire, "extra_token", request.extra_token);
      omitEmpty(wire, "is_mobile", request.is_mobile);
      omitEmpty(wire, "seed", seed);
      omitEmpty(wire, "now_ms", request.now_ms);
      const { meta, data } = await this.#core.solve("kasada", wire, call);
      return withResponse<KasadaCDResponse>(data, meta);
    });
  }
}
