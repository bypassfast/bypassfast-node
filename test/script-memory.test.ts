import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptMemory } from "../src/script-memory.js";

describe("ScriptMemory", () => {
  it("remembers a miss until it is registered or expires", () => {
    let now = 1_000;
    const memory = new ScriptMemory(4, () => now, 60_000);
    assert.equal(memory.recentlyMissed("k"), false);
    memory.markMissed("k");
    assert.equal(memory.recentlyMissed("k"), true);
    memory.markRegistered("k");
    assert.equal(memory.recentlyMissed("k"), false);
    memory.markMissed("k");
    now += 59_999;
    assert.equal(memory.recentlyMissed("k"), true);
    now += 1;
    assert.equal(memory.recentlyMissed("k"), false, "expired");
    assert.equal(memory.has("k"), false, "an expired miss is dropped on read");
  });

  it("ignores empty keys", () => {
    const memory = new ScriptMemory(4, () => 0, 60_000);
    memory.markMissed("");
    memory.markRegistered("");
    assert.equal(memory.size, 0);
    assert.equal(memory.recentlyMissed(""), false);
  });

  it("evicts the oldest miss at capacity and refreshes a repeated one", () => {
    const memory = new ScriptMemory(3, () => 0, 60_000);
    memory.markMissed("a");
    memory.markMissed("b");
    memory.markMissed("c");
    memory.markMissed("a"); // a becomes the newest
    memory.markMissed("d");
    assert.equal(memory.has("b"), false, "b was the oldest");
    assert.deepEqual(["a", "c", "d"].map((key) => memory.has(key)), [true, true, true]);
    assert.equal(memory.size, 3);
  });
});
