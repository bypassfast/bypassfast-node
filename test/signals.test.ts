import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { combineSignals, combineSignalsFallback } from "../src/core.js";
import { RequestError } from "../src/index.js";
import { cdRequest, fakeFetch, hang, reply, testClient } from "./helpers.js";

describe("combineSignalsFallback", () => {
  it("aborts with the first source's reason", () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = combineSignalsFallback([a.signal, b.signal]);
    const reason = new Error("b first");
    b.abort(reason);
    a.abort(new Error("a later"));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, reason);
  });

  it("is aborted at once when a source already is", () => {
    const reason = new Error("already");
    const { signal } = combineSignalsFallback([new AbortController().signal, AbortSignal.abort(reason)]);
    assert.equal(signal.reason, reason);
  });

  it("release detaches from long-lived caller signals", () => {
    const caller = new AbortController();
    const { signal, release } = combineSignalsFallback([caller.signal, new AbortController().signal]);
    release();
    caller.abort();
    assert.equal(signal.aborted, false);
  });

  it("passes zero or one signal through unchanged", () => {
    assert.equal(combineSignals([undefined]).signal, undefined);
    const only = new AbortController().signal;
    assert.equal(combineSignals([undefined, only]).signal, only);
  });
});

describe("cancellation without AbortSignal.any (Node 18)", () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  before(() => {
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
  });
  after(() => {
    if (original !== undefined) {
      Object.defineProperty(AbortSignal, "any", original);
    }
  });

  it("still applies the per-attempt timeout", async () => {
    const { client } = testClient(fakeFetch(hang).fetch, { timeoutMs: 20 });
    await assert.rejects(client.kasada.cd(cdRequest), RequestError);
  });

  it("still rejects with the caller's reason during a request and a backoff wait", async () => {
    const { client } = testClient(fakeFetch(hang).fetch);
    const controller = new AbortController();
    const reason = new Error("stop");
    setTimeout(() => controller.abort(reason), 5);
    await assert.rejects(client.kasada.cd(cdRequest, { signal: controller.signal }), (error: unknown) => error === reason);

    const busy = fakeFetch(() => reply(429, { error: "solver_busy", retry_after_ms: 5000 }));
    const waiting = testClient(busy.fetch, { retry: { maxRetries: 1 } }, { sleep: undefined, now: undefined }).client;
    const second = new AbortController();
    setTimeout(() => second.abort(reason), 20);
    await assert.rejects(waiting.kasada.cd(cdRequest, { signal: second.signal }), (error: unknown) => error === reason);
    assert.equal(busy.requests.length, 1);
  });

  it("still enforces a deadline", async () => {
    const { client, clock } = testClient(fakeFetch(hang).fetch);
    await assert.rejects(client.kasada.cd(cdRequest, { deadline: clock.now + 20 }), { name: "TimeoutError" });
  });
});
