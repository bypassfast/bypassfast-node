import { withResponse, type Core } from "./core.js";
import { ValidationError } from "./errors.js";
import type { RequestOptions, ResponseMeta } from "./types.js";
import { always, base64, base64Length, omitEmpty, requireObject, resolveScriptId, scriptId, toBytes, type Wire } from "./wire.js";

/** `mode: "sensor"`: generate Bot Manager sensor_data. */
export interface AkamaiSensorRequest {
  /** Full target URL of the next real request. */
  url: string;
  /** Exact User-Agent your client sends on the real request. */
  ua: string;
  /** Current `_abck` cookie; "0~-1~-1~-1~-1" on the first call. */
  abck: string;
  /** `bm_sz` cookie from the challenge response. */
  bm_sz: string;
  /**
   * The sensor script: raw bytes, or a string sent as UTF-8. The SDK sends
   * only its SHA-256 as `script_id` and uploads the bytes (base64) once, only
   * when the API has never seen that script.
   */
  script?: string | Uint8Array;
  /** SHA-256 hex of the raw script, from an earlier response or `scriptId()`; use it alone when the bytes are not at hand. */
  script_id?: string;
  /** URL the script was fetched from. */
  script_url: string;
  accept_language?: string;
  language?: string;
  timezone?: string;
  /** `session` from the previous sensor response of this flow. With a session, script and script_id are not sent. */
  session?: string;
  /**
   * Hold the response until a person's interval (2.5-4 s) has passed since
   * the previous sensor of this session. A page posts seconds apart, and
   * sites score sessions whose sensors arrive a fraction of a second apart.
   */
  pace?: boolean;
  /**
   * Ask for the `Akamai-BM-Telemetry` header value too, for sites that protect
   * their API calls with that header instead of a sensor post.
   */
  telemetry?: boolean;
}

export interface AkamaiSensorResponse {
  cost: number;
  success: boolean;
  /** Post as `{"sensor_data":"..."}` to the sensor endpoint. */
  sensor_data: string;
  /** User-Agent bound into the sensor; replay it byte-identical. */
  ua: string;
  session: string;
  language: string;
  script_id: string;
  /**
   * The device's UA client hints. Send `sec-ch-ua`, `sec-ch-ua-mobile` and
   * `sec-ch-ua-platform` on every request; the others only to sites whose
   * Accept-CH header asks for them.
   */
  client_hints?: Record<string, string>;
  /** The `Akamai-BM-Telemetry` header value, when `telemetry` was requested. */
  telemetry?: string;
  /** How long a paced response was held before answering, in ms. */
  paced_ms?: number;
  readonly response: ResponseMeta;
}

/**
 * `mode: "sbsd"`: the encrypted side-band payload. The script travels as its
 * SHA-256 and is uploaded once on a cache miss, as for the sensor. Keep the
 * `session` the first response returns and send it on every later SBSD (or
 * sensor) call for that page; later calls may send `script_id` instead of
 * `script`.
 */
export interface AkamaiSBSDRequest {
  url: string;
  ua: string;
  /** Raw bytes or a UTF-8 string; base64-encoded by the SDK. */
  script?: string | Uint8Array;
  /** `script_id` from an earlier response, instead of `script`. */
  script_id?: string;
  session?: string;
  /** "telemetry" asks for the page's next telemetry post instead of the fingerprint. */
  sbsd_post?: string;
  /** Hold the response until the post is due (see `wait_ms`). */
  pace?: boolean;
  script_url: string;
  /** The `sbsd_o` cookie (not `_abck`). */
  sbsd_o: string;
  accept_language?: string;
  language?: string;
  timezone?: string;
  uuid?: string;
  resource_urls?: string[];
  dom_resource_urls?: string[];
}

export interface AkamaiSBSDResponse {
  cost: number;
  success: boolean;
  /** The complete encrypted body to submit upstream. */
  body: string;
  session: string;
  script_id: string;
  /** The device's UA client hints (see `AkamaiSensorResponse.client_hints`). */
  client_hints?: Record<string, string>;
  /** "telemetry" on a telemetry response. */
  sbsd_post?: string;
  /** Which of the two telemetry posts this is. */
  ind?: number;
  /** Wait this long before posting `body`. */
  wait_ms?: number;
  readonly response: ResponseMeta;
}

/** `mode: "cpt"`: the pure-compute Sec-CPT proof of work. */
export interface AkamaiCPTRequest {
  token: string;
  /** 1 to 65536. */
  difficulty: number;
}

export interface AkamaiCPTResponse {
  cost: number;
  success: boolean;
  answers: string[];
  readonly response: ResponseMeta;
}

/**
 * `mode: "sec_cpt"`: the sec-cpt "Challenge Validation" page. token,
 * timestamp, nonce, difficulty and count come from the iframe's challenge
 * attribute or a chained /_sec/verify response; sec_cpt is the cookie value.
 */
export interface AkamaiSecCPTRequest {
  token: string;
  sec_cpt: string;
  timestamp: number;
  nonce: string;
  difficulty: number;
  count: number;
}

export interface AkamaiSecCPTResponse {
  cost: number;
  success: boolean;
  answers: string[];
  /** Exact body to POST to /_sec/verify?provider=<provider>. */
  body: string;
  readonly response: ResponseMeta;
}

/** The `script_id` of raw Akamai JavaScript; `scriptId()` under its original name. */
export function akamaiScriptId(script: string | Uint8Array): string {
  return scriptId(script);
}

/** Akamai Bot Manager: sensor, SBSD, CPT and sec-cpt. */
export class AkamaiService {
  readonly #core: Core;

  /** @internal Use `client.akamai`. */
  constructor(core: Core) {
    this.#core = core;
  }

  /**
   * Generates sensor_data. A fresh session sends the script as its
   * `script_id` and uploads the bytes once on a cache miss; a call that
   * continues a `session` sends neither.
   */
  sensor(request: AkamaiSensorRequest, options?: RequestOptions): Promise<AkamaiSensorResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      // With a session the API already holds the script state: script and
      // script_id are not sent.
      const fresh = isEmptyString(request.session);
      const script = fresh ? toBytes(request.script) : new Uint8Array(0);
      const id = fresh ? resolveScriptId(request.script_id, script) : "";
      const build = (withScript: boolean): Wire => {
        const out: Wire = { mode: "sensor" };
        always(out, "url", request.url, "");
        always(out, "ua", request.ua, "");
        always(out, "abck", request.abck, "");
        always(out, "bm_sz", request.bm_sz, "");
        if (withScript) {
          out["script"] = base64(script);
        }
        omitEmpty(out, "script_id", id);
        always(out, "script_url", request.script_url, "");
        omitEmpty(out, "accept_language", request.accept_language);
        omitEmpty(out, "language", request.language);
        omitEmpty(out, "timezone", request.timezone);
        omitEmpty(out, "session", request.session);
        omitEmpty(out, "pace", request.pace);
        omitEmpty(out, "telemetry", request.telemetry);
        return out;
      };
      const { meta, data } = await this.#core.solveScript(
        { solver: "akamai", key: `akamai:${id}`, hasScript: script.length > 0, scriptBytes: base64Length(script.length), build },
        call,
      );
      if (isEmptyString(data["script_id"]) && id !== "") {
        data["script_id"] = id;
      }
      return withResponse<AkamaiSensorResponse>(data, meta);
    });
  }

  /** Generates an encrypted SBSD payload. */
  sbsd(request: AkamaiSBSDRequest, options?: RequestOptions): Promise<AkamaiSBSDResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      const script = toBytes(request.script);
      const id = resolveScriptId(request.script_id, script);
      if (id === "") {
        throw new ValidationError("script", "set script, or script_id from an earlier response");
      }
      const build = (withScript: boolean): Wire => {
        const wire: Wire = { mode: "sbsd" };
        always(wire, "url", request.url, "");
        always(wire, "ua", request.ua, "");
        if (withScript) {
          wire["script"] = base64(script);
        }
        omitEmpty(wire, "script_id", id);
        omitEmpty(wire, "session", request.session);
        omitEmpty(wire, "sbsd_post", request.sbsd_post);
        omitEmpty(wire, "pace", request.pace);
        always(wire, "script_url", request.script_url, "");
        always(wire, "sbsd_o", request.sbsd_o, "");
        omitEmpty(wire, "accept_language", request.accept_language);
        omitEmpty(wire, "language", request.language);
        omitEmpty(wire, "timezone", request.timezone);
        omitEmpty(wire, "uuid", request.uuid);
        omitEmpty(wire, "resource_urls", request.resource_urls);
        omitEmpty(wire, "dom_resource_urls", request.dom_resource_urls);
        return wire;
      };
      const { meta, data } = await this.#core.solveScript(
        { solver: "akamai", key: `akamai:${id}`, hasScript: script.length > 0, scriptBytes: base64Length(script.length), build },
        call,
      );
      if (isEmptyString(data["script_id"])) {
        data["script_id"] = id;
      }
      return withResponse<AkamaiSBSDResponse>(data, meta);
    });
  }

  /** Solves a Sec-CPT proof-of-work challenge. */
  cpt(request: AkamaiCPTRequest, options?: RequestOptions): Promise<AkamaiCPTResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      const wire: Wire = { mode: "cpt" };
      always(wire, "token", request.token, "");
      always(wire, "difficulty", request.difficulty, 0);
      const { meta, data } = await this.#core.solve("akamai", wire, call);
      return withResponse<AkamaiCPTResponse>(data, meta);
    });
  }

  /** Solves the proof of work of a sec-cpt challenge page. */
  secCpt(request: AkamaiSecCPTRequest, options?: RequestOptions): Promise<AkamaiSecCPTResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      const wire: Wire = { mode: "sec_cpt" };
      always(wire, "token", request.token, "");
      always(wire, "sec_cpt", request.sec_cpt, "");
      always(wire, "timestamp", request.timestamp, 0);
      always(wire, "nonce", request.nonce, "");
      always(wire, "difficulty", request.difficulty, 0);
      always(wire, "count", request.count, 0);
      const { meta, data } = await this.#core.solve("akamai", wire, call);
      return withResponse<AkamaiSecCPTResponse>(data, meta);
    });
  }
}

function isEmptyString(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
