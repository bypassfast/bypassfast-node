import { withResponse, type Call, type Core } from "./core.js";
import { ValidationError } from "./errors.js";
import type { RequestOptions, ResponseMeta } from "./types.js";
import { always, omitEmpty, requireObject, type Wire } from "./wire.js";

/** Browser persona family a session runs as. */
export type PerimeterxPlatform = "chrome-windows" | "chrome-mac";

/**
 * What `init` accepts for `platform`: a persona family, or `"auto"` to have the
 * solver draw Windows or macOS and (when `ua` is omitted) a current Chrome major
 * per session. Send `"auto"` only through exits that fit both Windows and macOS
 * clients; pin the platform on an exit of one OS class.
 */
export type PerimeterxPlatformRequest = PerimeterxPlatform | "auto";

/** A cookie to install before the page fetch, or one the solver holds. `expires` is Unix seconds, 0 for a session cookie. */
export interface PerimeterxCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  secure?: boolean;
  http_only?: boolean;
}

/** `mode: "init"`: run the page-sensor session through your proxy. */
export interface PerimeterxInitRequest {
  /** The application page a user would open. Required. */
  url: string;
  /** The exit the whole flow shares: http(s):// or socks5(h):// with credentials. Required. */
  proxy: string;
  /** Desktop Chrome UA; omit it and the solver draws one and returns it as `ua`. */
  ua?: string;
  /**
   * The Accept-Language your own requests send; the session keeps it. Omit it and the solver draws
   * a real Chrome value for the proxy exit's country and returns it as `accept_language`.
   */
  accept_language?: string;
  /** Ignored by the PerimeterX solver: it takes the session's time zone from where the exit is. */
  timezone?: string;
  /**
   * Default chrome-windows; must agree with `ua` when one is sent. `"auto"` draws
   * the platform (and, without `ua`, the Chrome major) per session; read the
   * draw from the response's `platform` and `ua`.
   */
  platform?: PerimeterxPlatformRequest;
  referer?: string;
  /** Extra lower-case request headers for the page fetch. */
  headers?: Record<string, string>;
  /** Cookies you already hold for the site. */
  cookies?: PerimeterxCookie[];
  /** HUMAN application id (PX........); required for sites the API does not infer. */
  app_id?: string;
}

/** The enforcement response exactly as your request received it. */
export interface PerimeterxBlockedResponse {
  /** URL of the blocked request; may be omitted when the hold request sets `url`. */
  url?: string;
  method?: string;
  /** 428 for the JSON block, 403 or 200 for an HTML block page. */
  status: number;
  /** Response headers with lower-case names, repeated headers comma-joined (include set-cookie). */
  headers?: Record<string, string>;
  /** The raw decoded body; base64 it when it is not valid text and set `body_encoding`. */
  body: string;
  /** "base64" when `body` is base64-encoded bytes. */
  body_encoding?: "base64";
  /** Shorthand for `body_encoding: "base64"`. */
  body_base64?: boolean;
}

/** `mode: "holdcaptcha"`: solve the press-and-hold challenge inside an existing session. */
export interface PerimeterxHoldRequest {
  /** `session` from the previous init or hold. Required. */
  session: string;
  /** The same exit used for init and the blocked request. Required. */
  proxy: string;
  /** The enforcement response. Required. */
  blocked: PerimeterxBlockedResponse;
  /** Used only when `blocked.url` is empty. */
  url?: string;
  /** Defaults to the session's UA. */
  ua?: string;
  /** Blocked request context (referer, origin), lower-case names. */
  headers?: Record<string, string>;
  /**
   * The cookies you hold for the site at the block (the set the blocked request carried, HUMAN's
   * included). The solver lays them over its session jar so the hold runs with the site's current
   * session and other protection layers, then returns only HUMAN's cookies and the ones the hold
   * set or changed. Without them the solver refreshes the page itself before the hold.
   */
  cookies?: PerimeterxCookie[];
}

export interface PerimeterxRetryAdvice {
  change_exit: boolean;
  reason: string;
}

/**
 * Result of init or a hold. `success: false` means the hold was rejected: it
 * is billed, it is not an error, and `cookies` are the ones you already had.
 */
export interface PerimeterxResponse {
  success: boolean;
  /** Set every one of these, then send (or retry once) your request. */
  cookies: PerimeterxCookie[];
  session: string;
  /** Present only when the solver can prove a safe retry action. */
  retry?: PerimeterxRetryAdvice;
  /** The UA the session runs as; send every request of the session with it. */
  ua?: string;
  /**
   * The Accept-Language the session runs as; send every request of the session with it. When you
   * sent none to init this is the value the solver drew for the exit's country.
   */
  accept_language?: string;
  /** The platform the session runs as; your client hints and TLS stack must match it. */
  platform?: PerimeterxPlatform;
  /**
   * The UA client hints the session sends: send `sec-ch-ua`, `sec-ch-ua-mobile`
   * and `sec-ch-ua-platform` on every request of the session, and the others
   * only to sites whose Accept-CH header asks for them.
   */
  client_hints?: Record<string, string>;
  cost: number;
  readonly response: ResponseMeta;
  /** `!success`. */
  readonly rejected: boolean;
  /** The hold was rejected and the solver advises moving to another exit and starting from init. */
  readonly changeExit: boolean;
}

/** PerimeterX / HUMAN: init and press-and-hold. Requests may be up to 2 MiB. */
export class PerimeterxService {
  readonly #core: Core;

  /** @internal Use `client.perimeterx`. */
  constructor(core: Core) {
    this.#core = core;
  }

  /** Runs the page-sensor session and returns cookies plus a session. */
  init(request: PerimeterxInitRequest, options?: RequestOptions): Promise<PerimeterxResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      requireNonEmpty("url", request.url);
      requireNonEmpty("proxy", request.proxy);
      const wire: Wire = { mode: "init" };
      omitEmpty(wire, "url", request.url);
      always(wire, "proxy", request.proxy, "");
      omitEmpty(wire, "ua", request.ua);
      omitEmpty(wire, "accept_language", request.accept_language);
      omitEmpty(wire, "timezone", request.timezone);
      omitEmpty(wire, "platform", request.platform);
      omitEmpty(wire, "referer", request.referer);
      omitEmpty(wire, "headers", request.headers);
      omitEmpty(wire, "cookies", cookiesWire(request.cookies));
      omitEmpty(wire, "app_id", request.app_id);
      const result = await this.#solve(wire, call);
      adoptAcceptLanguage(result, request.accept_language);
      return result;
    });
  }

  /** Solves the press-and-hold challenge behind a blocked response and returns refreshed cookies. */
  solveHold(request: PerimeterxHoldRequest, options?: RequestOptions): Promise<PerimeterxResponse> {
    return this.#core.run(options, async (call) => {
      requireObject(request);
      requireNonEmpty("session", request.session);
      requireNonEmpty("proxy", request.proxy);
      const blocked = request.blocked;
      if (blocked === undefined || blocked === null) {
        throw new ValidationError("blocked", "must not be null or undefined");
      }
      if (typeof blocked !== "object" || Array.isArray(blocked)) {
        throw new ValidationError("blocked", "must be an object");
      }
      if (isEmptyString(blocked.url) && isEmptyString(request.url)) {
        throw new ValidationError("blocked.url", "must not be empty when url is empty");
      }
      let bodyEncoding = "";
      if (blocked.body_base64 === true || blocked.body_encoding === "base64") {
        bodyEncoding = "base64";
      } else if (!isEmptyString(blocked.body_encoding)) {
        throw new ValidationError("blocked.body_encoding", 'must be "base64" or omitted');
      }
      const blockedWire: Wire = {};
      always(blockedWire, "url", blocked.url, "");
      omitEmpty(blockedWire, "method", blocked.method);
      always(blockedWire, "status", blocked.status, 0);
      omitEmpty(blockedWire, "headers", blocked.headers);
      always(blockedWire, "body", blocked.body, "");
      omitEmpty(blockedWire, "body_encoding", bodyEncoding);

      const wire: Wire = { mode: "holdcaptcha" };
      omitEmpty(wire, "url", request.url);
      always(wire, "proxy", request.proxy, "");
      omitEmpty(wire, "ua", request.ua);
      omitEmpty(wire, "headers", request.headers);
      omitEmpty(wire, "cookies", cookiesWire(request.cookies));
      omitEmpty(wire, "session", request.session);
      wire["blocked"] = blockedWire;
      return this.#solve(wire, call);
    });
  }

  async #solve(wire: Wire, call: Call): Promise<PerimeterxResponse> {
    const { meta, data } = await this.#core.solve("perimeterx", wire, call);
    Object.defineProperties(data, {
      rejected: {
        get(this: Record<string, unknown>): boolean {
          return this["success"] !== true;
        },
        enumerable: false,
        configurable: true,
      },
      changeExit: {
        get(this: Record<string, unknown>): boolean {
          const retry = this["retry"] as { change_exit?: unknown } | null | undefined;
          return this["success"] !== true && retry?.change_exit === true;
        },
        enumerable: false,
        configurable: true,
      },
    });
    return withResponse<PerimeterxResponse>(data, meta);
  }
}

/**
 * Makes `accept_language` the value to send on every request of the session: the one the API
 * returned (drawn for the exit's country when the caller set none), else the caller's own.
 */
function adoptAcceptLanguage(result: PerimeterxResponse, requested: string | undefined): void {
  const returned = (result as { accept_language?: unknown }).accept_language;
  if (typeof returned === "string" && returned !== "") {
    return;
  }
  if (typeof requested === "string" && requested !== "") {
    (result as { accept_language?: string }).accept_language = requested;
  }
}

function cookiesWire(cookies: PerimeterxCookie[] | undefined): Wire[] | undefined {
  if (cookies === undefined || cookies === null) {
    return undefined;
  }
  if (!Array.isArray(cookies)) {
    throw new ValidationError("cookies", "must be an array");
  }
  return cookies.map((cookie, index) => {
    if (cookie === null || typeof cookie !== "object") {
      throw new ValidationError(`cookies[${index}]`, "must be an object");
    }
    const out: Wire = {};
    always(out, "name", cookie.name, "");
    always(out, "value", cookie.value, "");
    omitEmpty(out, "domain", cookie.domain);
    omitEmpty(out, "path", cookie.path);
    omitEmpty(out, "expires", cookie.expires);
    omitEmpty(out, "secure", cookie.secure);
    omitEmpty(out, "http_only", cookie.http_only);
    return out;
  });
}

function requireNonEmpty(field: string, value: unknown): void {
  if (isEmptyString(value)) {
    throw new ValidationError(field, "must not be empty");
  }
}

function isEmptyString(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}
