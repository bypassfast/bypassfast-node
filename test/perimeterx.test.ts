import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APIError, ValidationError, type PerimeterxHoldRequest } from "../src/index.js";
import { fakeFetch, reply, testClient } from "./helpers.js";

const MiB = 1024 * 1024;
const proxy = "socks5h://user:pass@proxy.example.net:1080";

describe("perimeterx", () => {
  it("sends the init and holdcaptcha contracts", async () => {
    const { fetch, requests } = fakeFetch((request) =>
      request.json()["mode"] === "init"
        ? reply(200, {
            success: true,
            cookies: [{ name: "_pxvid", value: "v", domain: ".example.com", path: "/" }],
            session: "sess-1",
            cost: 0.004,
          })
        : reply(200, { success: false, cookies: [], session: "sess-2", cost: 0.004 }),
    );
    const { client } = testClient(fetch, { compressionThreshold: -1 });

    const init = await client.perimeterx.init({
      url: "https://www.example.com/en/booking",
      proxy,
      ua: "Mozilla/5.0 Chrome/153.0.0.0",
      platform: "chrome-mac",
      cookies: [{ name: "ak_bmsc", value: "x", domain: ".example.com", path: "/", http_only: true, extra: "dropped" } as never],
      headers: { "x-custom": "value" },
    });
    assert.equal(init.session, "sess-1");
    assert.equal(init.cost, 0.004);
    assert.equal(init.cookies.length, 1);
    assert.equal(init.response.attempts, 1);
    assert.equal(init.rejected, false);
    assert.equal(init.changeExit, false);

    const hold = await client.perimeterx.solveHold({
      session: init.session,
      proxy,
      blocked: {
        url: "https://www.example.com/api/v1/availability",
        method: "POST",
        status: 428,
        headers: { "content-type": "application/json" },
        body: "eyJhcHBJZCI6IlBYYWJjIn0=",
        body_base64: true,
      },
    });
    assert.equal(hold.success, false);
    assert.equal(hold.rejected, true);
    assert.equal(hold.changeExit, false);
    assert.equal(hold.retry, undefined);

    const [initWire, holdWire] = requests.map((r) => r.json());
    assert.deepEqual(initWire, {
      mode: "init",
      url: "https://www.example.com/en/booking",
      proxy,
      ua: "Mozilla/5.0 Chrome/153.0.0.0",
      platform: "chrome-mac",
      headers: { "x-custom": "value" },
      cookies: [{ name: "ak_bmsc", value: "x", domain: ".example.com", path: "/", http_only: true }],
    });
    assert.deepEqual(holdWire, {
      mode: "holdcaptcha",
      proxy,
      session: "sess-1",
      blocked: {
        url: "https://www.example.com/api/v1/availability",
        method: "POST",
        status: 428,
        headers: { "content-type": "application/json" },
        body: "eyJhcHBJZCI6IlBYYWJjIn0=",
        body_encoding: "base64",
      },
    });
  });

  it("omits ua when unset and returns the solver's draw", async () => {
    const { fetch, requests } = fakeFetch(() =>
      reply(200, { success: true, cookies: [], session: "sess-3", ua: "Mozilla/5.0 Chrome/152.0.0.0", cost: 0.004 }),
    );
    const { client } = testClient(fetch);
    const result = await client.perimeterx.init({ url: "https://www.example.com/", proxy });
    assert.ok(!("ua" in (requests[0]?.json() ?? {})));
    assert.equal(result.ua, "Mozilla/5.0 Chrome/152.0.0.0");
  });

  it("accepts body_encoding as on the wire, and a top-level url instead of blocked.url", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, cookies: [], session: "s", cost: 0.004 }));
    const { client } = testClient(fetch);
    await client.perimeterx.solveHold({
      session: "s",
      proxy,
      url: "https://www.example.com/blocked",
      blocked: { status: 403, body: "PGh0bWw+", body_encoding: "base64" },
    });
    const body = requests[0]?.json() ?? {};
    assert.equal(body["url"], "https://www.example.com/blocked");
    assert.deepEqual(body["blocked"], { url: "", status: 403, body: "PGh0bWw+", body_encoding: "base64" });
  });

  it("exposes changeExit only for a rejected hold that advises it", async () => {
    const { fetch } = fakeFetch(() =>
      reply(200, { success: false, cookies: [], session: "s", retry: { change_exit: true, reason: "exit_scored" }, cost: 0.004 }),
    );
    const { client } = testClient(fetch);
    const result = await client.perimeterx.solveHold({ session: "s", proxy, blocked: { url: "https://www.example.com/", status: 428, body: "{}" } });
    assert.equal(result.rejected, true);
    assert.equal(result.changeExit, true);
    assert.deepEqual(Object.keys(result).sort(), ["cookies", "cost", "retry", "session", "success"]);
  });

  it("validates requests locally", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    const blocked = { url: "https://www.example.com/", status: 428, body: "{}" };
    const cases: [string, () => Promise<unknown>][] = [
      ["request", () => client.perimeterx.init(null as never)],
      ["url", () => client.perimeterx.init({ url: "", proxy })],
      ["proxy", () => client.perimeterx.init({ url: "https://www.example.com/", proxy: "" })],
      ["request", () => client.perimeterx.solveHold(undefined as never)],
      ["session", () => client.perimeterx.solveHold({ session: "", proxy, blocked })],
      ["proxy", () => client.perimeterx.solveHold({ session: "s", proxy: "", blocked })],
      ["blocked", () => client.perimeterx.solveHold({ session: "s", proxy } as PerimeterxHoldRequest)],
      ["blocked.url", () => client.perimeterx.solveHold({ session: "s", proxy, blocked: { status: 428, body: "{}" } })],
      [
        "blocked.body_encoding",
        () => client.perimeterx.solveHold({ session: "s", proxy, blocked: { ...blocked, body_encoding: "gzip" as "base64" } }),
      ],
      ["cookies[0]", () => client.perimeterx.init({ url: "https://www.example.com/", proxy, cookies: [null as never] })],
    ];
    for (const [field, call] of cases) {
      await assert.rejects(call(), (error: unknown) => error instanceof ValidationError && error.field === field, field);
    }
    assert.equal(requests.length, 0);
  });

  it("allows 2 MiB block pages and rejects larger ones locally", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, cookies: [], session: "s", cost: 0.004 }));
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const hold: PerimeterxHoldRequest = {
      session: "s",
      proxy,
      blocked: { url: "https://www.example.com/", status: 403, body: "px-captcha ".repeat(Math.floor(1.5 * MiB / 11)) },
    };
    const result = await client.perimeterx.solveHold(hold);
    assert.equal(result.success, true);
    assert.ok((requests[0]?.body?.length ?? 0) > MiB);

    hold.blocked.body = "x".repeat(2 * MiB + 1);
    await assert.rejects(client.perimeterx.solveHold(hold), (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.message, "bypassfast: invalid request: encoded JSON exceeds the 2 MiB API limit");
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it("does not retry proxy_error but retries target_error", async () => {
    const proxyError = fakeFetch(() =>
      reply(424, { error: "proxy_error", message: "your proxy rejected the credentials (407)", stage: "prelude", reason: "proxy_auth_failed" }),
    );
    const error = await testClient(proxyError.fetch, { retry: { maxRetries: 2 } })
      .client.perimeterx.init({ url: "https://www.example.com/", proxy })
      .catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError);
    assert.equal(error.reason, "proxy_auth_failed");
    assert.equal(error.stage, "prelude");
    assert.equal(error.retryable, false);
    assert.equal(proxyError.requests.length, 1);

    const targetError = fakeFetch((_request, index) =>
      index === 0 ? reply(424, { error: "target_error" }) : reply(200, { success: true, cookies: [], session: "s", cost: 0.004 }),
    );
    const result = await testClient(targetError.fetch, { retry: { maxRetries: 2 } }).client.perimeterx.init({
      url: "https://www.example.com/",
      proxy,
    });
    assert.equal(result.response.attempts, 2);
  });
});
