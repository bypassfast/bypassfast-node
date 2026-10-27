import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { akamaiScriptId, APIError, scriptId, ValidationError } from "../src/index.js";
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
  it("sends the script as its hash, uploads it once on a miss, and is compact afterwards", async () => {
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0
        ? reply(409, { error_code: "script_cache_miss" })
        : reply(200, {
            cost: 0.002,
            success: true,
            sensor_data: "sensor",
            ua: "ua",
            session: "session",
            script_id: "server-id",
            client_hints: { "sec-ch-ua": '"Chromium";v="155"', "sec-ch-ua-mobile": "?0" },
          }),
    );
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const script = new TextEncoder().encode("raw <sensor> javascript");
    const request = { ...sensorBase, script };

    const first = await client.akamai.sensor(request);
    assert.equal(first.sensor_data, "sensor");
    assert.equal(first.script_id, "server-id");
    assert.equal(first.response.attempts, 2);
    assert.deepEqual(first.client_hints, { "sec-ch-ua": '"Chromium";v="155"', "sec-ch-ua-mobile": "?0" });

    const second = await client.akamai.sensor(request);
    assert.equal(second.response.attempts, 1);

    assert.equal(requests.length, 3);
    const [compact, upload, again] = requests.map((r) => r.json());
    assert.ok(!("script" in (compact ?? {})));
    assert.equal(compact?.["script_id"], sha256(script));
    assert.equal(upload?.["script"], b64(script));
    assert.equal(upload?.["script_id"], sha256(script));
    assert.ok(!("script" in (again ?? {})));
    for (const body of [compact, upload, again]) {
      assert.ok(!("config" in (body ?? {})), "config is never sent");
    }
    assert.deepEqual(Object.keys(upload ?? {}), ["mode", "url", "ua", "abck", "bm_sz", "script", "script_id", "script_url"]);
  });

  it("treats a string script as UTF-8 bytes", async () => {
    const { fetch, requests } = fakeFetch((_request, index) => (index === 0 ? reply(409, { error_code: "script_cache_miss" }) : reply(200, { success: true })));
    const { client } = testClient(fetch);
    const result = await client.akamai.sensor({ ...sensorBase, script: "var é = 1;" });
    const digest = sha256(Buffer.from("var é = 1;", "utf8"));
    assert.equal(requests[0]?.json()["script_id"], digest);
    assert.equal(requests[1]?.json()["script"], b64(Buffer.from("var é = 1;", "utf8")));
    assert.equal(result.script_id, digest, "local script_id fills a missing response field");
    assert.equal(akamaiScriptId("var é = 1;"), scriptId(Buffer.from("var é = 1;", "utf8")));
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

  it("returns the miss when only a script_id was given", async () => {
    const { fetch, requests } = fakeFetch(() => reply(409, { error_code: "script_cache_miss" }));
    const { client } = testClient(fetch);
    await assert.rejects(client.akamai.sensor({ ...sensorBase, script_id: scriptId("not at hand") }), { code: "script_cache_miss" });
    assert.equal(requests.length, 1);
  });

  it("retries script_cache_unavailable before falling back, and merges attempts", async () => {
    const script = "var sensor = 1;";
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0 || index === 1
        ? reply(503, { error_code: "script_cache_unavailable" })
        : reply(200, { success: true, sensor_data: "sensor" }),
    );
    const { client } = testClient(fetch, { retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 } });
    const result = await client.akamai.sensor({ ...sensorBase, script });
    assert.equal(result.response.attempts, 3);
    const scripts = requests.map((r) => r.json()["script"] as string | undefined);
    assert.deepEqual(scripts, [undefined, undefined, b64(script)]);
  });

  it("adds the compact attempt to a failed fallback", async () => {
    const script = "var sensor = 2;";
    const { fetch } = fakeFetch((_request, index) =>
      index === 0 ? reply(409, { error_code: "script_cache_miss" }) : reply(422, { error_code: "unsupported_script" }),
    );
    const { client } = testClient(fetch);
    const error = await client.akamai.sensor({ ...sensorBase, script }).catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError);
    assert.equal(error.code, "unsupported_script");
    assert.equal(error.response.attempts, 2);
  });

  it("after a miss, sends the script directly for a minute, then hash-first again", async () => {
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0 || index === 1 ? reply(409, { error_code: "script_cache_miss" }) : reply(200, { success: true }),
    );
    const { client, clock } = testClient(fetch);
    const request = { ...sensorBase, script: "brand new script" };
    // Hash-first misses and the upload misses too: the miss stays remembered.
    await assert.rejects(client.akamai.sensor(request), { code: "script_cache_miss" });
    // Inside the window the script travels directly, and registers.
    const second = await client.akamai.sensor(request);
    assert.equal(second.response.attempts, 1);
    // Registered: hash-first again.
    await client.akamai.sensor(request);
    assert.deepEqual(
      requests.map((r) => "script" in r.json()),
      [false, true, true, false],
    );
    // An old miss is forgotten.
    await assert.rejects(
      testClient(fakeFetch(() => reply(409, { error_code: "script_cache_miss" })).fetch).client.akamai.sensor(request),
      { code: "script_cache_miss" },
    );
    clock.now += 60_000;
    await client.akamai.sensor(request);
    assert.equal("script" in (requests.at(-1)?.json() ?? {}), false);
  });

  it("validates script_id locally", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, {}));
    const { client } = testClient(fetch);
    await assert.rejects(
      client.akamai.sensor({ ...sensorBase, script: "script", script_id: "0".repeat(64) }),
      (error: unknown) => error instanceof ValidationError && error.message === "bypassfast: invalid script_id: does not match the script bytes",
    );
    await assert.rejects(
      client.akamai.sensor({ ...sensorBase, script_id: "not-a-digest" }),
      (error: unknown) =>
        error instanceof ValidationError && error.message === "bypassfast: invalid script_id: must be a 64-character SHA-256 hex digest",
    );
    await assert.rejects(client.akamai.sensor({ ...sensorBase, script_id: ` ${"g".repeat(64)}` }), ValidationError);
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
      accept_language: "en-US",
    });
    const body = requests[0]?.json() ?? {};
    assert.ok(!("script" in body) && !("script_id" in body));
    assert.equal(body["session"], "prior");
    assert.equal(body["accept_language"], "en-US");
    assert.equal(result.script_id, undefined);
  });

  it("sends pace and telemetry only when set, and reads the telemetry header back", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true, session: "next", telemetry: "a=&&&e=bm&&&sensor_data=c2Vuc29y", paced_ms: 1200 }));
    const { client } = testClient(fetch);
    const plain = await client.akamai.sensor({ ...sensorBase, session: "prior" });
    const asked = await client.akamai.sensor({ ...sensorBase, session: "prior", pace: true, telemetry: true });
    assert.ok(!("pace" in (requests[0]?.json() ?? {})));
    assert.ok(!("telemetry" in (requests[0]?.json() ?? {})));
    assert.equal(requests[1]?.json()["pace"], true);
    assert.equal(requests[1]?.json()["telemetry"], true);
    assert.equal(plain.telemetry, "a=&&&e=bm&&&sensor_data=c2Vuc29y");
    assert.equal(asked.paced_ms, 1200);
  });

  it("remembers at most 256 misses", async () => {
    const { fetch, requests } = fakeFetch(() => reply(409, { error_code: "script_cache_miss" }));
    const { client } = testClient(fetch);
    for (let i = 0; i <= 256; i++) {
      await assert.rejects(client.akamai.sensor({ ...sensorBase, script: `script-${i}` }), { code: "script_cache_miss" });
    }
    let before = requests.length;
    await assert.rejects(client.akamai.sensor({ ...sensorBase, script: "script-256" }), { code: "script_cache_miss" });
    assert.equal(requests[before]?.json()["script"], b64("script-256"), "a remembered miss sends the script directly");
    assert.equal(requests.length, before + 1, "a direct upload that misses is not repeated");
    before = requests.length;
    await assert.rejects(client.akamai.sensor({ ...sensorBase, script: "script-0" }), { code: "script_cache_miss" });
    assert.ok(!("script" in (requests[before]?.json() ?? {})), "the oldest miss was forgotten: hash-first again");
  });
});

describe("akamai sbsd, cpt and sec_cpt", () => {
  it("sends the SBSD contract hash-first and uploads the script on a miss", async () => {
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0
        ? reply(409, { error_code: "script_cache_miss" })
        : reply(200, { success: true, body: "encrypted", ind: 1, wait_ms: 1200, client_hints: { "sec-ch-ua-mobile": "?0" } }),
    );
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
    assert.equal(result.response.attempts, 2);
    assert.equal(result.script_id, sha256("sbsd"), "local script_id fills a missing response field");
    assert.deepEqual(result.client_hints, { "sec-ch-ua-mobile": "?0" });
    const compact = requests[0]?.json() ?? {};
    assert.deepEqual(Object.keys(compact), ["mode", "url", "ua", "script_id", "sbsd_post", "pace", "script_url", "sbsd_o", "resource_urls"]);
    assert.equal(compact["mode"], "sbsd");
    assert.equal(compact["script_id"], sha256("sbsd"));
    const upload = requests[1]?.json() ?? {};
    assert.equal(upload["script"], b64("sbsd"));
    assert.deepEqual(Object.keys(upload).slice(2, 5), ["ua", "script", "script_id"]);
  });

  it("accepts script_id instead of a script and requires one of them", async () => {
    const { fetch, requests } = fakeFetch(() => reply(200, { success: true }));
    const { client } = testClient(fetch);
    const cached = scriptId("earlier");
    await client.akamai.sbsd({ url: "u", ua: "ua", script_id: `  ${cached.toUpperCase()}  `, script_url: "s", sbsd_o: "o", session: "sess" });
    assert.equal(requests[0]?.json()["script_id"], cached);
    assert.ok(!("script" in (requests[0]?.json() ?? {})));
    await assert.rejects(
      client.akamai.sbsd({ url: "u", ua: "ua", script_id: "   ", script_url: "s", sbsd_o: "o" }),
      (error: unknown) => error instanceof ValidationError && error.field === "script",
    );
    await assert.rejects(
      client.akamai.sbsd({ url: "u", ua: "ua", script_id: "cached", script_url: "s", sbsd_o: "o" }),
      (error: unknown) => error instanceof ValidationError && error.field === "script_id",
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
  it("sends the sensor contract hash-first with omitempty fields left out", async () => {
    const { fetch, requests } = fakeFetch((_request, index) =>
      index === 0
        ? reply(409, { error: "script_cache_miss" })
        : reply(200, { payload: "p", headers: { "x-kpsdk-ct": "v" }, client_hints: { "sec-ch-ua-platform": '"Windows"' }, script_id: "srv" }),
    );
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
    assert.deepEqual(result.client_hints, { "sec-ch-ua-platform": '"Windows"' });
    assert.equal(result.script_id, "srv");
    assert.equal(result.response.attempts, 2);
    assert.deepEqual(requests[0]?.json(), { mode: "sensor", script_id: sha256("p.js"), ua: "ua", page_origin: "https://www.example.com" });
    assert.deepEqual(requests[1]?.json(), { mode: "sensor", script: "p.js", script_id: sha256("p.js"), ua: "ua", page_origin: "https://www.example.com" });
    // The upload registered the script: the CD call for the same p.js is compact at once.
    const cd = await client.kasada.cd(cdRequest);
    assert.equal(cd.response.attempts, 1);
    assert.equal(cd.script_id, "srv");
    assert.ok(!("script" in (requests[2]?.json() ?? {})));
    assert.equal(requests[2]?.json()["script_id"], sha256("p.js"));
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
    assert.equal(result.script_id, sha256("p.js"));
    const body = requests[0]?.json() ?? {};
    assert.deepEqual(Object.keys(body), ["mode", "script_id", "st", "ct", "domain", "work_time", "rst", "d", "id", "duration", "fc", "subchallenge_count"]);
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

  it("sends the script as its hash and uploads it once on a cache miss", async () => {
    const { fetch, requests } = fakeFetch((_request: RecordedRequest, index: number) =>
      index === 0 ? reply(409, { error: "script_cache_miss" }) : reply(200, { payload: "payload", backend: "replay", duration_ms: 2, client_hints: { "sec-ch-ua-mobile": "?0" } }),
    );
    const { client } = testClient(fetch, { compressionThreshold: -1 });
    const first = await client.incapsula.reese84(reese);
    const result = await client.incapsula.reese84(reese);
    assert.equal(first.response.attempts, 2);
    assert.equal(first.script_id, sha256("raw script"));
    assert.deepEqual(first.client_hints, { "sec-ch-ua-mobile": "?0" });
    assert.equal(result.response.attempts, 1);
    assert.equal(result.backend, "replay");
    const bodies = requests.map((r) => r.json());
    assert.deepEqual(
      bodies.map((body) => body["script"]),
      [undefined, "raw script", undefined],
    );
    for (const body of bodies) {
      assert.equal(body["mode"], "reese84");
      assert.equal(body["script_id"], sha256("raw script"));
      assert.equal(body["document_html"], reese.document_html);
      assert.deepEqual(body["document_script_source_groups"], reese.document_script_source_groups);
    }
    assert.deepEqual(Object.keys(bodies[1] ?? {}), [
      "mode",
      "script",
      "script_id",
      "ua",
      "script_url",
      "url",
      "document_html",
      "document_script_source_groups",
    ]);
  });

  it("remembers a miss per mode and content", async () => {
    const { fetch, requests } = fakeFetch((_request, index) => (index === 0 ? reply(409, { error: "script_cache_miss" }) : reply(200, { payload: "p", backend: "b" })));
    const { client } = testClient(fetch);
    await client.incapsula.reese84(reese); // miss, then upload
    await client.incapsula.reese84(reese); // registered: compact
    await client.incapsula.utmvc({ script: "raw script", script_url: reese.script_url, url: reese.url, ua: "ua", session_ids: ["s1"] }); // other mode: compact
    await client.incapsula.reese84({ ...reese, script: "changed script" }); // other content: compact
    const bodies = requests.map((r) => r.json());
    assert.deepEqual(
      bodies.map((body) => body["script"]),
      [undefined, "raw script", undefined, undefined, undefined],
    );
    assert.equal(bodies[3]?.["mode"], "utmvc");
    assert.deepEqual(bodies[3]?.["session_ids"], ["s1"]);
    assert.equal(bodies[4]?.["script_id"], sha256("changed script"));
  });

  it("returns a miss when only a script_id was given, and a failed upload", async () => {
    const { fetch, requests } = fakeFetch(() => reply(409, { error: "script_cache_miss" }));
    const { client } = testClient(fetch);
    const error = await client.incapsula.reese84(reese).catch((caught: unknown) => caught);
    assert.ok(error instanceof APIError);
    assert.equal(error.response.attempts, 2, "hash-first, then the upload");
    await assert.rejects(client.incapsula.reese84({ ...reese, script: undefined, script_id: sha256("raw script") }), { code: "script_cache_miss" });
    assert.equal(requests.length, 3);
  });
});
