import { AkamaiService } from "./akamai.js";
import { Core, withResponse } from "./core.js";
import { ValidationError } from "./errors.js";
import { IncapsulaService } from "./incapsula.js";
import { KasadaService } from "./kasada.js";
import { PerimeterxService } from "./perimeterx.js";
import type { BypassFastOptions, RequestOptions, ResponseMeta, Solver } from "./types.js";

/** Prepaid USD balance. */
export interface Balance {
  errorId: number;
  org_id: string;
  balance: number;
  balance_cents: number;
  currency: string;
  readonly response: ResponseMeta;
}

const SOLVERS: readonly Solver[] = ["akamai", "kasada", "incapsula", "perimeterx"];

/**
 * Bypass Fast API client. Create one per API key and reuse it: it holds the
 * script memory that lets repeated Akamai and Incapsula scripts travel as a
 * hash instead of the full body.
 */
export class BypassFast {
  /** Akamai Bot Manager: sensor, SBSD, CPT and sec-cpt. */
  readonly akamai: AkamaiService;
  /** Kasada: sensor and CD. */
  readonly kasada: KasadaService;
  /** Imperva / Incapsula: Reese84 and UTMVC. */
  readonly incapsula: IncapsulaService;
  /** PerimeterX / HUMAN: init and press-and-hold. */
  readonly perimeterx: PerimeterxService;
  readonly #core: Core;

  /**
   * @param apiKey Your API key. Never log it.
   * @throws ValidationError for an empty key or invalid options.
   */
  constructor(apiKey: string, options?: BypassFastOptions) {
    this.#core = new Core(apiKey, options);
    this.akamai = new AkamaiService(this.#core);
    this.kasada = new KasadaService(this.#core);
    this.incapsula = new IncapsulaService(this.#core);
    this.perimeterx = new PerimeterxService(this.#core);
  }

  /** Reads the prepaid balance (`GET /balance`). */
  balance(options?: RequestOptions): Promise<Balance> {
    return this.#core.run(options, async (call) => {
      const { meta, data } = await this.#core.get("/balance", call);
      return withResponse<Balance>(data, meta);
    });
  }

  /**
   * Sends a raw request body to `POST /v1/solve/{solver}` and returns the JSON
   * response. Prefer the typed service methods; this is the escape hatch for
   * fields this SDK version does not model. Script memory is not used.
   */
  solve<T extends object = Record<string, unknown>>(
    solver: Solver,
    body: object,
    options?: RequestOptions,
  ): Promise<T & { readonly response: ResponseMeta }> {
    return this.#core.run(options, async (call) => {
      if (!SOLVERS.includes(solver)) {
        throw new ValidationError("solver", "must be akamai, kasada, incapsula, or perimeterx");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ValidationError("request", "must be an object");
      }
      const { meta, data } = await this.#core.solve(solver, body, call);
      return withResponse<T & { readonly response: ResponseMeta }>(data, meta);
    });
  }
}

