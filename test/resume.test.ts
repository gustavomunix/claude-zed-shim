import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planResume, type SessionFileProbe } from "../src/resume.ts";
import type { TurnBoundary } from "../src/store.ts";

const msg = (content: string) => ({ role: "user", content });

const probe = (options: { chain?: "clean" | "branched" | "missing"; has?: boolean; last?: string } = {}): SessionFileProbe => ({
  exists: true,
  hasEntry: () => options.has ?? true,
  chainAfterLeaf: () => options.chain ?? "clean",
  lastEntry: () => options.last ?? "l1",
});

describe("planResume", () => {
  it("transfers history without a session", () => {
    const plan = planResume({
      turns: [],
      prints: ["a"],
      priorMessages: [msg("a")],
      probeFor: () => null,
    });
    assert.deepEqual(plan, {
      missedMessages: [msg("a")],
      transcript: "history",
      clearBinding: false,
      reason: "no-session",
    });
  });

  it("resumes latest and injects missed messages", () => {
    const plan = planResume({
      turns: [{ count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" }],
      prints: ["a", "b"],
      priorMessages: [msg("a"), msg("b")],
      sessionId: "s1",
      leafUuid: "l1",
      probeFor: () => probe({ chain: "clean" }),
    });
    assert.equal(plan.resume, "s1");
    assert.equal(plan.transcript, "missed");
    assert.deepEqual(plan.missedMessages, [msg("b")]);
  });

  it("forks a branched rewind", () => {
    const plan = planResume({
      turns: [
        { count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" },
        { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
      ],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      leafUuid: "l2",
      probeFor: () => probe({ chain: "branched", has: true, last: "l2" }),
    });
    assert.deepEqual(plan.forkAt, { sessionId: "s1", leafUuid: "l1" });
    assert.equal(plan.rewindIndex, 0);
    assert.equal(plan.resume, "s1");
  });

  it("transfers history when the session file is missing", () => {
    const plan = planResume({
      turns: [],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      probeFor: () => ({ exists: false, hasEntry: () => false, chainAfterLeaf: () => "missing", lastEntry: () => undefined }),
    });
    assert.equal(plan.clearBinding, true);
    assert.equal(plan.transcript, "history");
    assert.equal(plan.resume, undefined);
  });

  it("transfers history when the rewind leaf is gone", () => {
    const plan = planResume({
      turns: [
        { count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" },
        { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
      ],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      leafUuid: "l2",
      probeFor: () => probe({ chain: "clean", has: false }),
    });
    assert.equal(plan.clearBinding, true);
    assert.equal(plan.transcript, "history");
    assert.equal(plan.resume, undefined);
  });

  it("forks a rewind into another session", () => {
    const plan = planResume({
      turns: [
        { count: 1, hash: "a", leafUuid: "l1", sessionId: "s0" },
        { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
      ],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      leafUuid: "l2",
      probeFor: (id) => (id === "s0" ? probe({ chain: "clean", has: true, last: "l1" }) : probe({ chain: "clean", has: true, last: "l2" })),
    });
    assert.deepEqual(plan.forkAt, { sessionId: "s0", leafUuid: "l1" });
  });

  it("forks when the leaf is not the last entry", () => {
    const plan = planResume({
      turns: [
        { count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" },
        { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
      ],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      leafUuid: "l2",
      probeFor: () => probe({ chain: "clean", has: true, last: "later" }),
    });
    assert.deepEqual(plan.forkAt, { sessionId: "s1", leafUuid: "l1" });
  });

  it("forks a latest resume with a branched binding leaf", () => {
    const plan = planResume({
      turns: [{ count: 1, hash: "a", leafUuid: "l1", sessionId: "s1" }],
      prints: ["a", "b"],
      priorMessages: [msg("a"), msg("b")],
      sessionId: "s1",
      leafUuid: "l1",
      probeFor: () => probe({ chain: "branched", has: true, last: "l1" }),
    });
    assert.deepEqual(plan.forkAt, { sessionId: "s1", leafUuid: "l1" });
  });

  it("resumes untracked sessions without transcript", () => {
    const plan = planResume({
      turns: [],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      probeFor: () => probe(),
    });
    assert.equal(plan.resume, "s1");
    assert.equal(plan.transcript, "none");
    assert.equal(plan.reason, "untracked");
  });

  it("resumes a rewind with no leaf without truncating", () => {
    const plan = planResume({
      turns: [
        { count: 1, hash: "a" },
        { count: 2, hash: "b", leafUuid: "l2", sessionId: "s1" },
      ],
      prints: ["a"],
      priorMessages: [msg("a")],
      sessionId: "s1",
      probeFor: () => probe(),
    });
    assert.equal(plan.reason, "rewind-no-leaf");
    assert.equal(plan.resume, "s1");
    assert.equal(plan.rewindIndex, undefined);
  });
});
