import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { akamaiScriptId, APIError, ValidationError } from "../src/index.js";
import { cdRequest, fakeFetch, reply, testClient, type RecordedRequest } from "./helpers.js";

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const b64 = (value: Uint8Array | string): string => Buffer.from(value).toString("base64");

const sensorBase = {
  url: "https://www.example.com/checkout",
  ua: "Mozilla/5.0 Chrome/153.0.0.0",
  abck: "0~-1~-1~-1~-1",
  bm_sz: "bm",
  script_url: "https://www.example.com/_bm/a.js",
};

describe("akamai sensor", () => {
  it("uploads a script once, then sends only its script_id, and falls back on a cache miss", async () => {
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 1
        ? reply(409, { error_code: "script_cache_miss" })
        : reply(200, { cost: 0.002, success: true, sensor_data: "sensor", ua: "ua", session: "session", script_id: "server-id" }),
    );
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const script = new TextEncoder().encode("raw <sensor> javascript");
    const request = { ...sensorBase, script };

    const first = await client.akamai.sensor(request);
    assert.equal(first.sensor_data, "sensor");
    assert.equal(first.script_id, "server-id");
    assert.equal(first.response.attempts, 1);

    const second = await client.akamai.sensor(request);
    assert.equal(second.response.attempts, 2);

    assert.equal(requests.length, 3);
    const [upload, compact, fallback] = requests.map((r) => r.json());
    assert.equal(upload?.["script"], b64(script));
    assert.equal(upload?.["script_id"], sha256(script));
    assert.ok(!("script" in (compact ?? {})));
    assert.equal(compact?.["script_id"], sha256(script));
    assert.equal(fallback?.["script"], b64(script));
    for (const body of [upload, compact, fallback]) {
      assert.ok(!("config" in (body ?? {})), "config is sent only in debug mode");
    }
    assert.deepEqual(Object.keys(upload ?? {}), ["mode", "url", "ua", "abck", "bm_sz", "script", "script_id", "script_url"]);
  });

  it("treats a string script as UTF-8 bytes", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true }));
    const { client } = testClient(fetch);
    const result = await client.akamai.sensor({ ...sensorBase, script: "var é = 1;" });
    const body = requests[0]?.json();
    assert.equal(body?.["script"], b64(Buffer.from("var é = 1;", "utf8")));
    assert.equal(body?.["script_id"], sha256(Buffer.from("var é = 1;", "utf8")));
    assert.equal(result.script_id, sha256(Buffer.from("var é = 1;", "utf8")), "local script_id fills a missing response field");
    assert.equal(akamaiScriptId("var é = 1;"), akamaiScriptId(Buffer.from("var é = 1;", "utf8")));
  });

  it("sends config only in debug mode, with all four flags", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, sensor_data: "sensor" }));
    const { client } = testClient(fetch);
    await client.akamai.sensor({ ...sensorBase, debug: true, config: { touch: true } });
    await client.akamai.sensor({ ...sensorBase, debug: false, config: { touch: true } });
    const [debug, plain] = requests.map((r) => r.json());
    assert.deepEqual(debug?.["config"], { mouse: false, keyboard: false, touch: true, beta: false });
    assert.equal(debug?.["debug"], true);
    assert.ok(!("config" in (plain ?? {})) && !("debug" in (plain ?? {})));
  });

  it("tries an explicit script_id first and keeps the bytes for the fallback", async () => {
    const script = Buffer.from("raw script available for fallback");
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0 ? reply(409, { error_code: "script_cache_miss" }) : reply(200, { success: true, sensor_data: "sensor" }),
    );
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const result = await client.akamai.sensor({ ...sensorBase, script, script_id: akamaiScriptId(script).toUpperCase() });
    assert.equal(result.response.attempts, 2);
    assert.equal(requests.length, 2);
    assert.ok(!("script" in (requests[0]?.json() ?? {})));
    assert.equal(requests[0]?.json()["script_id"], akamaiScriptId(script), "script_id is lower-cased");
    assert.equal(requests[1]?.json()["script"], b64(script));
  });

  it("retries script_cache_unavailable before falling back, and merges attempts", async () => {
    const script = "var sensor = 1;";
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 1 || index === 2
        ? reply(503, { error_code: "script_cache_unavailable" })
        : reply(200, { success: true, sensor_data: "sensor" }),
    );
    const { client } = testClient(fetch, { retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 } });
    await client.akamai.sensor({ ...sensorBase, script });
    const result = await client.akamai.sensor({ ...sensorBase, script });
    assert.equal(result.response.attempts, 3);
    const scripts = requests.map((r) => r.json()["script"] as string | undefined);
    assert.deepEqual(scripts, [b64(script), undefined, undefined, b64(script)]);
  });

  it("adds the compact attempt to a failed fallback", async () => {
    const script = "var sensor = 2;";
    const { fetch } = fakeFetch((_request, index) =>
      index === 0
        ? reply(200, { success: true })
        : index === 1
          ? reply(409, { error_code: "script_cache_miss" })
          : reply(422, { error_code: "unsupported_script" }),
    );
    const { client } = testClient(fetch);
    await client.akamai.sensor({ ...sensorBase, script });
    const error = await client.akamai.sensor({ ...sensorBase, script }).catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError);
    assert.equal(error.code, "unsupported_script");
    assert.equal(error.response.attempts, 2);
  });

  it("does not fall back when the script was sent in full", async () => {
    const { fetch, requests } = fakeFetch(() => reply(409, { error_code: "script_cache_miss" }));
    const { client } = testClient(fetch);
    await assert.rejects(client.akamai.sensor({ ...sensorBase, script: "x" }), { code: "script_cache_miss" });
    assert.equal(requests.length, 1);
  });

  it("validates script_id locally", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    await assert.rejects(
      client.akamai.sensor({ ...sensorBase, script: "script", script_id: "0".repeat(64) }),
      (error: unknown) => error instanceof ValidationError && error.message === "bypassfast: invalid script_id: does not match script bytes",
    );
    await assert.rejects(
      client.akamai.sensor({ ...sensorBase, script_id: "not-a-digest" }),
      (error: unknown) =>
        error instanceof ValidationError && error.message === "bypassfast: invalid script_id: must be a 64-character SHA-256 hex digest",
    );
    await assert.rejects(client.akamai.sensor({ ...sensorBase, script_id: ` ${"a".repeat(64)}` }), ValidationError);
    assert.equal(requests.length, 0);
  });

  it("sends neither script nor script_id with a session", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, session: "next" }));
    const { client } = testClient(fetch);
    const result = await client.akamai.sensor({
      ...sensorBase,
      script: "script",
      script_id: "garbage is not validated with a session",
      session: "prior",
      device: {},
      accept_language: "en-US",
    });
    const body = requests[0]?.json() ?? {};
    assert.ok(!("script" in body) && !("script_id" in body) && !("device" in body));
    assert.equal(body["session"], "prior");
    assert.equal(body["accept_language"], "en-US");
    assert.equal(result.script_id, undefined);
  });

  it("evicts the least recently used script after 256 others", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true }));
    const { client } = testClient(fetch);
    await client.akamai.sensor({ ...sensorBase, script: "script-0" });
    await client.akamai.sensor({ ...sensorBase, script: "script-0" });
    assert.ok(!("script" in (requests[1]?.json() ?? {})), "remembered");
    for (let i = 1; i <= 256; i++) {
      await client.akamai.sensor({ ...sensorBase, script: `script-${i}` });
    }
    const before = requests.length;
    await client.akamai.sensor({ ...sensorBase, script: "script-0" });
    assert.equal(requests[before]?.json()["script"], b64("script-0"), "evicted, so uploaded again");
    await client.akamai.sensor({ ...sensorBase, script: "script-256" });
    assert.ok(!("script" in (requests[before + 1]?.json() ?? {})), "recent entries survive");
  });
});

describe("akamai sbsd, cpt and sec_cpt", () => {
  it("sends the SBSD contract", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, body: "encrypted", ind: 1, wait_ms: 1200 }));
    const { client } = testClient(fetch);
    const result = await client.akamai.sbsd({
      url: "https://www.example.com/",
      ua: "ua",
      script: Buffer.from("sbsd"),
      script_url: "https://www.example.com/sbsd.js",
      sbsd_o: "cookie",
      sbsd_post: "telemetry",
      pace: true,
      resource_urls: ["https://www.example.com/a.css"],
    });
    assert.equal(result.body, "encrypted");
    assert.equal(result.wait_ms, 1200);
    const body = requests[0]?.json() ?? {};
    assert.deepEqual(Object.keys(body), ["mode", "url", "ua", "script", "sbsd_post", "pace", "script_url", "sbsd_o", "resource_urls"]);
    assert.equal(body["mode"], "sbsd");
    assert.equal(body["script"], b64("sbsd"));
  });

  it("accepts script_id instead of a script and requires one of them", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true }));
    const { client } = testClient(fetch);
    await client.akamai.sbsd({ url: "u", ua: "ua", script_id: "  ABC  ", script_url: "s", sbsd_o: "o", session: "sess" });
    assert.equal(requests[0]?.json()["script_id"], "abc");
    assert.ok(!("script" in (requests[0]?.json() ?? {})));
    await assert.rejects(
      client.akamai.sbsd({ url: "u", ua: "ua", script_id: "   ", script_url: "s", sbsd_o: "o" }),
      (error: unknown) => error instanceof ValidationError && error.field === "script",
    );
    assert.equal(requests.length, 1);
  });

  it("sends the CPT and sec_cpt contracts", async () => {
    const { fetch, requests } = fakeFetch((request) =>
      request.json()["mode"] === "cpt" ? reply(200, { success: true, answers: ["a"] }) : reply(200, { success: true, answers: ["0.8"], body: "{}" }),
    );
    const { client } = testClient(fetch);
    const cpt = await client.akamai.cpt({ token: "token", difficulty: 16 });
    const sec = await client.akamai.secCpt({
      token: "token",
      sec_cpt: "prefix~1~rest",
      timestamp: 1783387618,
      nonce: "nonce",
      difficulty: 10000,
      count: 1,
    });
    assert.deepEqual(cpt.answers, ["a"]);
    assert.equal(sec.body, "{}");
    assert.deepEqual(requests[0]?.json(), { mode: "cpt", token: "token", difficulty: 16 });
    assert.deepEqual(requests[1]?.json(), {
      mode: "sec_cpt",
      token: "token",
      sec_cpt: "prefix~1~rest",
      timestamp: 1783387618,
      nonce: "nonce",
      difficulty: 10000,
      count: 1,
    });
  });
});

describe("kasada", () => {
  it("sends the sensor contract with omitempty fields left out", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { payload: "p", headers: { "x-kpsdk-ct": "v" } }));
    const { client } = testClient(fetch);
    const result = await client.kasada.sensor({
      script: "p.js",
      ua: "ua",
      page_origin: "https://www.example.com",
      ancestor_origins: [],
      headers: {},
      force_pool_variation: false,
      now_ms: 0,
    });
    assert.deepEqual(result.headers, { "x-kpsdk-ct": "v" });
    assert.deepEqual(requests[0]?.json(), { mode: "sensor", script: "p.js", ua: "ua", page_origin: "https://www.example.com" });
  });

  it("serializes seed as a bare uint64 JSON number", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { payload: "p" }));
    const { client } = testClient(fetch);
    const seeds: [bigint | number | string, string][] = [
      [18446744073709551615n, "18446744073709551615"],
      ["9007199254740993", "9007199254740993"],
      [42, "42"],
      ["007", "7"],
    ];
    for (const [seed, text] of seeds) {
      await client.kasada.sensor({ script: "p.js", ua: "ua", seed });
      assert.ok(requests.at(-1)?.text().endsWith(`"seed":${text}}`), String(seed));
    }
    for (const seed of [0, 0n, "0"]) {
      await client.kasada.cd({ ...cdRequest, seed });
      assert.ok(!("seed" in (requests.at(-1)?.json() ?? {})), `seed ${String(seed)} is omitted`);
    }
    const count = requests.length;
    for (const seed of [-1, 2 ** 60, 1.5, "abc", "-1", "1e3", 18446744073709551616n, -1n]) {
      await assert.rejects(
        client.kasada.sensor({ script: "p.js", ua: "ua", seed }),
        (error: unknown) => error instanceof ValidationError && error.field === "seed",
        String(seed),
      );
    }
    assert.equal(requests.length, count);
  });

  it("always sends the CD challenge fields", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { payload: "{}", duration_ms: 5 }));
    const { client } = testClient(fetch);
    const result = await client.kasada.cd({ ...cdRequest, st: 0, work_time: 0, subchallenge_count: 2, is_mobile: false });
    assert.equal(result.duration_ms, 5);
    const body = requests[0]?.json() ?? {};
    assert.deepEqual(Object.keys(body), ["mode", "script", "st", "ct", "domain", "work_time", "rst", "d", "id", "duration", "fc", "subchallenge_count"]);
    assert.equal(body["st"], 0);
    assert.equal(body["work_time"], 0);
  });
});

describe("incapsula", () => {
  const reese = {
    script: "raw script",
    script_url: "https://www.example.com/loader",
    url: "https://www.example.com",
    ua: "ua",
    document_html: '<script async src="/static/build"></script>',
    document_script_source_groups: [["https://www.example.com/static/build"]],
  };

  it("omits a remembered script and resends it on a cache miss", async () => {
    const { fetch, requests } = fakeFetch((_request: RecordedRequest, index: number) =>
      index === 1 ? reply(409, { error: "script_cache_miss" }) : reply(200, { payload: "payload", backend: "replay", duration_ms: 2 }),
    );
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    await client.incapsula.reese84(reese);
    const result = await client.incapsula.reese84(reese);
    assert.equal(result.response.attempts, 2);
    assert.equal(result.backend, "replay");
    const bodies = requests.map((r) => r.json());
    assert.deepEqual(
      bodies.map((body) => body["script"]),
      ["raw script", undefined, "raw script"],
    );
    for (const body of bodies) {
      assert.equal(body["mode"], "reese84");
      assert.equal(body["document_html"], reese.document_html);
      assert.deepEqual(body["document_script_source_groups"], reese.document_script_source_groups);
    }
    assert.deepEqual(Object.keys(bodies[0] ?? {}), [
      "mode",
      "script",
      "ua",
      "script_url",
      "url",
      "document_html",
      "document_script_source_groups",
    ]);
  });

  it("keys the memory by mode and script URL and resends changed scripts", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { payload: "p", backend: "b" }));
    const { client } = testClient(fetch);
    await client.incapsula.reese84(reese);
    await client.incapsula.reese84({ ...reese, script: "changed script" });
    await client.incapsula.utmvc({ script: "changed script", script_url: reese.script_url, url: reese.url, ua: "ua", session_ids: ["s1"] });
    await client.incapsula.reese84({ ...reese, script: "changed script", script_url: "https://www.example.com/other" });
    await client.incapsula.reese84({ ...reese, script: "changed script" });
    const bodies = requests.map((r) => r.json());
    assert.deepEqual(
      bodies.map((body) => body["script"]),
      ["raw script", "changed script", "changed script", "changed script", undefined],
    );
    assert.equal(bodies[2]?.["mode"], "utmvc");
    assert.deepEqual(bodies[2]?.["session_ids"], ["s1"]);
  });

  it("does not remember scripts from failed calls", async () => {
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0 ? reply(422, { error: "unsupported_challenge" }) : reply(200, { payload: "p" }),
    );
    const { client } = testClient(fetch);
    await assert.rejects(client.incapsula.reese84(reese), { code: "unsupported_challenge" });
    await client.incapsula.reese84(reese);
    assert.equal(requests[1]?.json()["script"], "raw script");
  });
});
