import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchTurnHistory, type TurnBoundary } from "../src/store.ts";

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
