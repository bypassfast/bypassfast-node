import { withResponse, type Call, type Core } from "./core.js";
import type { RequestOptions, ResponseMeta } from "./types.js";
import { always, omitEmpty, requireObject, resolveScriptId, toBytes, type Wire } from "./wire.js";

/**
 * `mode: "reese84"`. `script` is raw JavaScript. It travels as its SHA-256
 * (`script_id`) and is uploaded once, only when the API has never seen it;
 * pass `script_id` instead when the source is not at hand.
 */
export interface IncapsulaReese84Request {
  script?: string | Uint8Array;
  /** SHA-256 hex of the raw script, from an earlier response or `scriptId()`. */
  script_id?: string;
  ua: string;
  /** Absolute URL this exact script was fetched from. */
  script_url: string;
  /** Absolute protected page URL. */
  url: string;
  accept_language?: string;
  ip?: string;
  pow?: string;
  old_token?: string;
  session?: string;
  headers?: Record<string, string>;
  /** The challenged page body the script was discovered in; send it for dynamic Reese84 pages. */
  document_html?: string;
  /** Pre-extracted advanced form of document_html. */
  document_script_source_groups?: string[][];
}

/** `mode: "utmvc"`: the ___utmvc cookie workflow. The script travels as its hash like Reese84. */
export interface IncapsulaUTMVCRequest {
  script?: string | Uint8Array;
  script_id?: string;
  ua: string;
  script_url: string;
  url: string;
  accept_language?: string;
  ip?: string;
  session?: string;
  headers?: Record<string, string>;
  session_ids?: string[];
}

/** Shared by Reese84 (device_id, session) and UTMVC (cookie, cookie_name, submit_path). */
export interface IncapsulaResponse {
  cost: number;
  payload: string;
  backend: string;
  device_id?: string;
  session?: string;
  /** Digest of the script the solve used. */
  script_id?: string;
  /**
   * The device's UA client hints. Send `sec-ch-ua`, `sec-ch-ua-mobile` and
   * `sec-ch-ua-platform` on every request; the others only to sites whose
   * Accept-CH header asks for them.
   */
  client_hints?: Record<string, string>;
  duration_ms: number;
  cookie?: string;
  cookie_name?: string;
  submit_path?: string;
  readonly response: ResponseMeta;
}

interface IncapsulaWireInput {
  mode: "reese84" | "utmvc";
  script?: string | Uint8Array;
  script_id?: string;
  ua?: string;
  script_url?: string;
  url?: string;
  accept_language?: string;
  ip?: string;
  pow?: string;
  old_token?: string;
  session?: string;
  headers?: Record<string, string>;
  session_ids?: string[];
  document_html?: string;
  document_script_source_groups?: string[][];
}

/** Imperva / Incapsula: Reese84 and UTMVC. */
export class IncapsulaService {
  readonly #core: Core;

  /** @internal Use `client.incapsula`. */
  constructor(core: Core) {
    this.#core = core;
  }

  /** Generates a Reese84 sensor payload. */
  reese84(request: IncapsulaReese84Request, options?: RequestOptions): Promise<IncapsulaResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      return this.#solve(
        {
          mode: "reese84",
          script: request.script,
          script_id: request.script_id,
          ua: request.ua,
          script_url: request.script_url,
          url: request.url,
          accept_language: request.accept_language,
          ip: request.ip,
          pow: request.pow,
          old_token: request.old_token,
          session: request.session,
          headers: request.headers,
          document_html: request.document_html,
          document_script_source_groups: request.document_script_source_groups?.map((group) => [...group]),
        },
        call,
      );
    });
  }

  /** Generates the ___utmvc cookie and submission path. */
  utmvc(request: IncapsulaUTMVCRequest, options?: RequestOptions): Promise<IncapsulaResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      return this.#solve(
        {
          mode: "utmvc",
          script: request.script,
          script_id: request.script_id,
          ua: request.ua,
          script_url: request.script_url,
          url: request.url,
          accept_language: request.accept_language,
          ip: request.ip,
          session: request.session,
          headers: request.headers,
          session_ids: request.session_ids,
        },
        call,
      );
    });
  }

  async #solve(input: IncapsulaWireInput, call: Call): Promise<IncapsulaResponse> {
    const script = toBytes(input.script);
    const id = resolveScriptId(input.script_id, script);
    const source = Buffer.from(script.buffer, script.byteOffset, script.byteLength).toString("utf8");
    const build = (withScript: boolean): Wire => {
      const out: Wire = { mode: input.mode };
      if (withScript) {
        out["script"] = source;
      }
      omitEmpty(out, "script_id", id);
      always(out, "ua", input.ua, "");
      always(out, "script_url", input.script_url, "");
      always(out, "url", input.url, "");
      omitEmpty(out, "accept_language", input.accept_language);
      omitEmpty(out, "ip", input.ip);
      omitEmpty(out, "pow", input.pow);
      omitEmpty(out, "old_token", input.old_token);
      omitEmpty(out, "session", input.session);
      omitEmpty(out, "headers", input.headers);
      omitEmpty(out, "session_ids", input.session_ids);
      omitEmpty(out, "document_html", input.document_html);
      omitEmpty(out, "document_script_source_groups", input.document_script_source_groups);
      return out;
    };
    const { meta, data } = await this.#core.solveScript(
      { solver: "incapsula", key: `incapsula:${input.mode}:${id}`, hasScript: script.length > 0, scriptBytes: script.length, build },
      call,
    );
    if ((data["script_id"] === undefined || data["script_id"] === null || data["script_id"] === "") && id !== "") {
      data["script_id"] = id;
    }
    return withResponse<IncapsulaResponse>(data, meta);
  }
}
