import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conversationKey, storePath } from "../src/store.ts";

describe("storePath", () => {
  it("keeps the legacy path when CLAUDE_CONFIG_DIR is unset", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const legacy = storePath();
      assert.ok(legacy.includes("claude-zed-shim") && !legacy.includes(".claude-account"));
    } finally {
      if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
  it("partitions by CLAUDE_CONFIG_DIR", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      const legacy = storePath();
      process.env.CLAUDE_CONFIG_DIR = "C:\\Users\\x\\.claude-account2";
      const account2 = storePath();
      process.env.CLAUDE_CONFIG_DIR = "C:\\Users\\x\\.claude-account3";
      const account3 = storePath();
      assert.notEqual(account2, legacy);
      assert.notEqual(account3, account2);
    } finally {
      if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

describe("conversationKey", () => {
  it("stable across turns with same initial message", () => {
    const a = [{ role: "user", content: "hello" }];
    const b = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "more" }];
    const ka = conversationKey(a, "m");
    const kb = conversationKey(b, "m");
    assert.equal(ka, kb);
  });
  it("changes when earlier message edited", () => {
    const a = conversationKey([{ role: "user", content: "hello" }], "m");
    const b = conversationKey([{ role: "user", content: "hello!" }], "m");
    assert.notEqual(a, b);
  });
  it("differs by model", () => {
    const msgs = [{ role: "user", content: "hello" }];
    assert.notEqual(conversationKey(msgs, "a"), conversationKey(msgs, "b"));
  });
});
