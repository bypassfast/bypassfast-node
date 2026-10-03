import { addPriorAttempts, withResponse, type Call, type Core } from "./core.js";
import { isErrorCode } from "./errors.js";
import type { RequestOptions, ResponseMeta } from "./types.js";
import { always, omitEmpty, requireObject, sha256Hex, type Wire } from "./wire.js";

/**
 * `mode: "reese84"`. `script` is raw JavaScript; after a successful call the
 * client omits it for the same content at the same `script_url`.
 */
export interface IncapsulaReese84Request {
  script?: string;
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

/** `mode: "utmvc"`: the ___utmvc cookie workflow. */
export interface IncapsulaUTMVCRequest {
  script?: string;
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
  duration_ms: number;
  cookie?: string;
  cookie_name?: string;
  submit_path?: string;
  readonly response: ResponseMeta;
}

interface IncapsulaWireInput {
  mode: "reese84" | "utmvc";
  script?: string;
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
    const script = input.script ?? "";
    const cacheKey = `incapsula:${input.mode}:${input.script_url ?? ""}`;
    let scriptHash = "";
    let usedCompact = false;
    if (script !== "") {
      scriptHash = sha256Hex(script);
      usedCompact = this.#core.scripts.matches(cacheKey, scriptHash);
    }
    const wire = (withScript: boolean): Wire => {
      const out: Wire = { mode: input.mode };
      if (withScript) {
        omitEmpty(out, "script", script);
      }
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

    let result: { meta: ResponseMeta; data: Record<string, unknown> };
    try {
      result = await this.#core.solve("incapsula", wire(!usedCompact), call);
    } catch (error) {
      if (!usedCompact || !(isErrorCode(error, "script_cache_miss") || isErrorCode(error, "script_cache_unavailable"))) {
        throw error;
      }
      const prior = error.response.attempts;
      try {
        result = await this.#core.solve("incapsula", wire(true), call);
      } catch (fallbackError) {
        addPriorAttempts(fallbackError, prior);
        throw fallbackError;
      }
      result.meta.attempts += prior;
    }
    if (scriptHash !== "") {
      this.#core.scripts.put(cacheKey, scriptHash);
    }
    return withResponse<IncapsulaResponse>(result.data, result.meta);
  }
}
