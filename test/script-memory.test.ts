import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScriptMemory } from "../src/script-memory.js";

describe("ScriptMemory", () => {
  it("matches only a stored, identical, non-empty value", () => {
    const memory = new ScriptMemory(4);
    assert.equal(memory.matches("k", "v"), false);
    memory.put("k", "v");
    assert.equal(memory.matches("k", "v"), true);
    assert.equal(memory.matches("k", "other"), false);
    assert.equal(memory.matches("k", ""), false);
  });

  it("ignores empty keys and values", () => {
    const memory = new ScriptMemory(4);
    memory.put("", "v");
    memory.put("k", "");
    assert.equal(memory.size, 0);
  });

  it("evicts the least recently used entry at capacity", () => {
    const memory = new ScriptMemory(3);
    memory.put("a", "1");
    memory.put("b", "2");
    memory.put("c", "3");
    assert.equal(memory.matches("a", "1"), true, "a hit refreshes a");
    memory.put("d", "4");
    assert.equal(memory.has("b"), false, "b was least recently used");
    assert.deepEqual(["a", "c", "d"].map((key) => memory.has(key)), [true, true, true]);
    assert.equal(memory.size, 3);
  });

  it("a mismatch does not refresh recency", () => {
    const memory = new ScriptMemory(2);
    memory.put("a", "1");
    memory.put("b", "2");
    assert.equal(memory.matches("a", "wrong"), false);
    memory.put("c", "3");
    assert.equal(memory.has("a"), false);
    assert.equal(memory.has("b"), true);
  });

  it("put replaces a value and refreshes recency", () => {
    const memory = new ScriptMemory(2);
    memory.put("a", "1");
    memory.put("b", "2");
    memory.put("a", "1b");
    memory.put("c", "3");
    assert.equal(memory.has("b"), false);
    assert.equal(memory.matches("a", "1b"), true);
    assert.equal(memory.size, 2);
  });
});
