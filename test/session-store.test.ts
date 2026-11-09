import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionLeafUuid,
  getSessionTurns,
  matchTurnHistory,
  recordTurnStart,
  rewindSessionTurns,
  setForeignSessionId,
  type TurnBoundary,
} from "../src/store.ts";

const turns: TurnBoundary[] = [
  { count: 1, hash: "a", leafUuid: "leaf-a", sessionId: "s1" },
  { count: 2, hash: "b", leafUuid: "leaf-b", sessionId: "s1" },
];

describe("matchTurnHistory", () => {
  it("returns untracked without boundaries", () => {
    assert.deepEqual(matchTurnHistory([], ["a"]), { kind: "untracked" });
  });

  it("matches the latest boundary with extra history", () => {
    assert.deepEqual(matchTurnHistory(turns, ["a", "b", "c"]), { kind: "latest", count: 2 });
  });

  it("detects a rewind to an earlier boundary", () => {
    assert.deepEqual(matchTurnHistory(turns, ["a"]), {
      kind: "rewind",
      index: 0,
      leafUuid: "leaf-a",
      sessionId: "s1",
    });
  });

  it("detects divergence", () => {
    assert.deepEqual(matchTurnHistory(turns, ["a", "x"]), { kind: "diverged" });
  });
});

describe("session boundaries", () => {
  const withTempData = (run: () => void) => {
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousCfg = process.env.CLAUDE_CONFIG_DIR;
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-session-"));
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

  it("records a pending boundary before the binding exists", () => {
    withTempData(() => {
      recordTurnStart("pending", { count: 1, hash: "a" });
      setForeignSessionId("pending", "s1", { leafUuid: "leaf-a" });
      assert.deepEqual(
        getSessionTurns("pending").map((turn) => [turn.count, turn.hash, turn.leafUuid]),
        [[1, "a", "leaf-a"]],
      );
    });
  });

  it("appends a new boundary and updates the last leaf", () => {
    withTempData(() => {
      setForeignSessionId("k2", "s1", { leafUuid: "leaf-a" });
      recordTurnStart("k2", { count: 1, hash: "a" });
      setForeignSessionId("k2", "s1", { leafUuid: "leaf-b" });
      recordTurnStart("k2", { count: 2, hash: "b" });
      setForeignSessionId("k2", "s1", { leafUuid: "leaf-c" });
      assert.deepEqual(getSessionTurns("k2").map((turn) => turn.count), [1, 2]);
      assert.equal(getSessionTurns("k2").at(-1)?.leafUuid, "leaf-c");
      assert.equal(getSessionLeafUuid("k2"), "leaf-c");
    });
  });

  it("stamps old boundaries when the session changes", () => {
    withTempData(() => {
      setForeignSessionId("k4", "s1", { leafUuid: "leaf-a" });
      recordTurnStart("k4", { count: 1, hash: "a" });
      setForeignSessionId("k4", "s1", { leafUuid: "leaf-b" });
      recordTurnStart("k4", { count: 2, hash: "b" });
      setForeignSessionId("k4", "s2", { leafUuid: "leaf-c" });
      assert.equal(getSessionTurns("k4")[0]?.sessionId, "s1");
    });
  });

  it("clears the leaf when rewinding into another session", () => {
    withTempData(() => {
      setForeignSessionId("k5", "s1", { leafUuid: "leaf-a" });
      recordTurnStart("k5", { count: 1, hash: "a" });
      setForeignSessionId("k5", "s1", { leafUuid: "leaf-b" });
      recordTurnStart("k5", { count: 2, hash: "b" });
      setForeignSessionId("k5", "s2", { leafUuid: "leaf-c" });
      rewindSessionTurns("k5", 0);
      assert.equal(getSessionLeafUuid("k5"), undefined);
    });
  });

  it("rewinds and forgets later boundaries", () => {
    withTempData(() => {
      setForeignSessionId("k3", "s1", { leafUuid: "leaf-a" });
      recordTurnStart("k3", { count: 1, hash: "a" });
      setForeignSessionId("k3", "s1", { leafUuid: "leaf-b" });
      recordTurnStart("k3", { count: 2, hash: "b" });
      rewindSessionTurns("k3", 0);
      assert.equal(getSessionTurns("k3").length, 1);
      assert.equal(getSessionLeafUuid("k3"), "leaf-b");
    });
  });
});
