import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspect } from "node:util";
import {
  APIError,
  BypassFastError,
  isErrorCode,
  RequestError,
  ResponseError,
  ValidationError,
  type ResponseMeta,
} from "../src/index.js";
import { cdRequest, fakeFetch, reply, testClient } from "./helpers.js";

function meta(statusCode: number, requestId = ""): ResponseMeta {
  return { statusCode, requestId, edge: "", serverTiming: "", attempts: 1 };
}

async function apiErrorFor(status: number, body: string, headers: Record<string, string> = {}): Promise<APIError> {
  const { fetch } = fakeFetch(() => reply(status, body, headers));
  const error = await testClient(fetch).client.kasada.cd(cdRequest).catch((caught: unknown) => caught);
  assert.ok(error instanceof APIError, `expected APIError, got ${String(error)}`);
  return error;
}

describe("error envelope decoding", () => {
  it("decodes the standard envelope", async () => {
    const error = await apiErrorFor(422, '{"error":"domain_not_allowed","message":"target is not allowed"}', {
      "x-request-id": "req-error",
    });
    assert.equal(error.code, "domain_not_allowed");
    assert.equal(error.apiMessage, "target is not allowed");
    assert.equal(error.response.statusCode, 422);
    assert.equal(error.response.requestId, "req-error");
    assert.equal(error.message, "bypassfast: domain_not_allowed (status 422, request req-error)");
    assert.ok(isErrorCode(error, "domain_not_allowed"));
  });

  it("decodes Akamai's legacy error_code envelope with stage and reason", async () => {
    const error = await apiErrorFor(
      422,
      '{"success":false,"error_code":"unsupported_script","message":"fresh script required","stage":"extract","reason":"r"}',
    );
    assert.equal(error.code, "unsupported_script");
    assert.equal(error.stage, "extract");
    assert.equal(error.reason, "r");
    assert.equal(error.message, "bypassfast: unsupported_script (status 422)");
  });

  it("prefers error over error_code", async () => {
    const error = await apiErrorFor(400, '{"error":"invalid_body","error_code":"invalid_json"}');
    assert.equal(error.code, "invalid_body");
  });

  it("falls back to http_error for malformed bodies", async () => {
    for (const body of ["", "not json", "[1]", "null", '"text"', "{}", '{"error":123,"message":"m"}', '{"error":"x","message":5}', '{"error":"","error_code":""}']) {
      const error = await apiErrorFor(400, body);
      assert.equal(error.code, "http_error", body);
      assert.equal(error.apiMessage, "", body);
      assert.equal(error.stage, "", body);
      assert.equal(error.message, "bypassfast: http_error (status 400)");
    }
  });

  it("keeps the code when retry_after_ms is malformed", async () => {
    for (const raw of ['"1500"', "{}", "[]", "true", "1e400", "-5", "0", "null"]) {
      const error = await apiErrorFor(429, `{"error":"solver_busy","retry_after_ms":${raw}}`);
      assert.equal(error.code, "solver_busy", raw);
      assert.equal(error.retryAfterMs, 0, raw);
    }
  });

  it("never puts the server message in the error text or inspection output", async () => {
    const secret = "echoed-input-secret";
    const error = await apiErrorFor(400, JSON.stringify({ error: "bad_request", message: secret }));
    assert.equal(error.apiMessage, secret);
    assert.ok(!error.message.includes(secret));
    assert.ok(!String(error).includes(secret));
    assert.ok(!inspect(error, { depth: 5 }).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
  });
});

describe("error types", () => {
  it("formats every error type", () => {
    assert.equal(new ValidationError("script_id", "must be hex").message, "bypassfast: invalid script_id: must be hex");
    assert.equal(new ValidationError("", "general problem").message, "bypassfast: general problem");
    assert.equal(new RequestError("GET /balance", new Error("boom"), 1).message, "bypassfast: GET /balance: boom");
    assert.equal(
      new ResponseError(meta(502, "req-1"), new Error("read response: reset")).message,
      "bypassfast: invalid response (status 502, request req-1): read response: reset",
    );
    assert.equal(new ResponseError(meta(200), new Error("x")).message, "bypassfast: invalid response (status 200): x");
    assert.equal(new APIError(meta(503, "req-2"), { code: "edge_unavailable" }).message, "bypassfast: edge_unavailable (status 503, request req-2)");
    assert.equal(new APIError(meta(500), { code: "" }).code, "http_error");
  });

  it("derives every error from BypassFastError with a stable name", () => {
    const errors = [
      new ValidationError("f", "m"),
      new RequestError("op", new Error("c"), 1),
      new ResponseError(meta(200), new Error("c")),
      new APIError(meta(400), { code: "bad_request" }),
    ];
    for (const error of errors) {
      assert.ok(error instanceof BypassFastError);
      assert.ok(error instanceof Error);
      assert.equal(error.name, error.constructor.name);
    }
    assert.equal(new BypassFastError("x").name, "BypassFastError");
  });

  it("isErrorCode matches only APIError codes", () => {
    const error = new APIError(meta(429), { code: "solver_busy" });
    assert.ok(isErrorCode(error, "solver_busy"));
    assert.ok(!isErrorCode(error, "quota_exceeded"));
    assert.ok(!isErrorCode(new ValidationError("solver_busy", "x"), "solver_busy"));
    assert.ok(!isErrorCode(undefined, "solver_busy"));
    assert.ok(!isErrorCode({ code: "solver_busy" }, "solver_busy"));
  });
});

describe("retryable", () => {
  const cases: [code: string, status: number, retryable: boolean][] = [
    ["proxy_error", 424, false],
    ["proxy_error", 503, false],
    ["quota_exceeded", 429, false],
    ["quota_exceeded", 503, false],
    ["billing_disabled", 402, false],
    ["hard_block", 422, false],
    ["unsupported_challenge", 422, false],
    ["unsupported_script", 422, false],
    ["solve_failed", 500, false],
    ["not_verified", 500, false],
    ["solve_timeout", 504, false],
    ["script_cache_miss", 409, false],
    ["solver_busy", 429, true],
    ["rate_limited", 429, true],
    ["quota_unavailable", 503, true],
    ["replay_unavailable", 503, true],
    ["edge_unavailable", 503, true],
    ["solver_unavailable", 502, true],
    ["api_key_store_unavailable", 503, true],
    ["org_status_unavailable", 503, true],
    ["cf_allowlist_unavailable", 503, true],
    ["request_cancelled", 503, true],
    ["internal", 500, true],
    ["internal_error", 500, true],
    ["no_devices_available", 503, true],
    ["device_unavailable", 503, true],
    ["script_cache_unavailable", 503, true],
    ["captcha_builder_unavailable", 503, true],
    ["target_error", 424, true],
    ["unknown_future_code", 500, true],
    ["unknown_future_code", 599, true],
    ["unknown_future_code", 499, false],
    ["unknown_future_code", 600, false],
    ["http_error", 502, true],
    ["http_error", 307, false],
    ["invalid_api_key", 401, false],
    ["domain_not_allowed", 403, false],
  ];
  for (const [code, status, expected] of cases) {
    it(`${code} at ${status} is ${expected ? "" : "not "}retryable`, () => {
      assert.equal(new APIError(meta(status), { code }).retryable, expected);
    });
  }
});
