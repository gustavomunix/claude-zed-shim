import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  conversationKey,
  getForeignSessionId,
  getSessionTurns,
  setForeignSessionId,
  storePath,
} from "../src/store.ts";

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

describe("session store persistence", () => {
  const withTempData = (run: () => void) => {
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousCfg = process.env.CLAUDE_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-store-"));
    try {
      process.env.XDG_DATA_HOME = dir;
      delete process.env.CLAUDE_CONFIG_DIR;
      run();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousCfg;
    }
  };

  it("writes the sessions file with private permissions", () => {
    withTempData(() => {
      setForeignSessionId("k", "session-1");
      assert.equal(getForeignSessionId("k"), "session-1");
      assert.equal(statSync(storePath()).mode & 0o777, 0o600);
    });
  });

  it("survives a corrupt sessions.json without throwing", () => {
    withTempData(() => {
      mkdirSync(dirname(storePath()), { recursive: true });
      writeFileSync(storePath(), "{ broken");
      assert.equal(getForeignSessionId("missing"), undefined);
      assert.deepEqual(getSessionTurns("missing"), []);
    });
  });
});
