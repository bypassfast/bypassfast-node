// Exercises the real global fetch against a loopback HTTP server: what an
// injected fake cannot show (Content-Length on the wire, fetch's own gzip
// decoding, redirect handling).
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { APIError, BypassFast, VERSION } from "../src/index.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("real fetch over loopback", () => {
  const seen: Seen[] = [];
  let destinationHits = 0;
  let destinationUrl = "";
  let apiUrl = "";
  const destination = createServer((_request, response) => {
    destinationHits++;
    response.end("{}");
  });
  const api = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
      if (request.url === "/redirect/v1/solve/kasada") {
        response.writeHead(307, { location: `${destinationUrl}/v1/solve/kasada` });
        response.end();
        return;
      }
      const body = gzipSync(JSON.stringify({ payload: "cipher", user_agent: "ua-out", duration_ms: 7 }));
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": body.length,
        "x-request-id": "req-loopback",
      });
      response.end(body);
    });
  });

  before(async () => {
    destinationUrl = await listen(destination);
    apiUrl = await listen(api);
  });

  after(async () => {
    await close(api);
    await close(destination);
  });

  it("sends Content-Length and gzip, and decodes a gzip response once", async () => {
    const client = new BypassFast("test-key", { baseUrl: apiUrl, userAgent: "loopback/1.0" });
    const result = await client.kasada.sensor({ script: "var challenge = 1;".repeat(200), ua: "ua-in" });
    assert.equal(result.payload, "cipher");
    assert.equal(result.response.requestId, "req-loopback");

    const request = seen.at(-1);
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.headers["transfer-encoding"], undefined, "the edge answers 411 to chunked bodies");
    assert.equal(Number(request.headers["content-length"]), request.body.length);
    assert.equal(request.headers["content-encoding"], "gzip");
    assert.equal(request.headers["x-api-key"], "test-key");
    assert.equal(request.headers["accept-encoding"], "gzip");
    assert.equal(request.headers["user-agent"], `bypassfast-node/${VERSION} loopback/1.0`);
    const body = JSON.parse(gunzipSync(request.body).toString("utf8")) as Record<string, unknown>;
    assert.equal(body["mode"], "sensor");
    assert.equal(body["ua"], "ua-in");
  });

  it("sends Content-Length for an uncompressed body", async () => {
    const client = new BypassFast("test-key", { baseUrl: apiUrl, compressionThreshold: -1 });
    await client.kasada.cd({ script: "p", st: 1, ct: "c", domain: "d", work_time: 1, rst: 1, d: 1, id: "i", duration: 1, fc: "f" });
    const request = seen.at(-1);
    assert.ok(request);
    assert.equal(request.headers["content-encoding"], undefined);
    assert.equal(Number(request.headers["content-length"]), request.body.length);
    assert.equal(request.headers["content-type"], "application/json");
  });

  it("never follows a redirect", async () => {
    const client = new BypassFast("test-key", { baseUrl: `${apiUrl}/redirect`, retry: { maxRetries: 2 } });
    const error = await client.kasada.cd({ script: "p", st: 1, ct: "c", domain: "d", work_time: 1, rst: 1, d: 1, id: "i", duration: 1, fc: "f" }).catch(
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof APIError);
    assert.equal(error.response.statusCode, 307);
    assert.equal(destinationHits, 0, "the API key must not reach another origin");
  });
});
