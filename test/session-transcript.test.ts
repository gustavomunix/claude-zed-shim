import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findClaudeSessionFile,
  lastChainEntryUuid,
  sessionChainAfterLeaf,
  sessionFileHasEntry,
} from "../src/session-transcript.ts";

const line = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;

describe("session transcript", () => {
  it("finds, inspects and detects a branched chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-transcript-"));
    try {
      const project = join(dir, "projects", "demo");
      mkdirSync(project, { recursive: true });
      const file = join(project, "s1.jsonl");
      writeFileSync(
        file,
        line({ type: "user", uuid: "u1", parentUuid: null }) +
          line({ type: "assistant", uuid: "a1", parentUuid: "u1" }) +
          line({ type: "user", uuid: "u2", parentUuid: "a1" }),
      );

      assert.equal(findClaudeSessionFile("s1", dir), file);
      assert.equal(sessionFileHasEntry(file, "a1"), true);
      assert.equal(sessionFileHasEntry(file, "missing"), false);
      assert.equal(sessionChainAfterLeaf(file, "u1"), "clean");
      assert.equal(lastChainEntryUuid(file), "u2");

      appendFileSync(file, line({ type: "assistant", uuid: "side", parentUuid: "other" }));
      assert.equal(sessionChainAfterLeaf(file, "u1"), "branched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing transcripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-transcript-"));
    try {
      assert.equal(findClaudeSessionFile("absent", dir), null);
      assert.equal(sessionChainAfterLeaf(join(dir, "nope.jsonl"), "u1"), "missing");
      assert.equal(lastChainEntryUuid(join(dir, "nope.jsonl")), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
