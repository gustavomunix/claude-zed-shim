import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TurnUsageTracker, resolveTurnUsage, type OpenAIUsage } from "../src/usage.ts";

const usage = (prompt: number, completion: number): OpenAIUsage => ({
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
});

describe("TurnUsageTracker", () => {
  it("keeps the max of message_start and message_delta", () => {
    const reported = new Map<string, OpenAIUsage>();
    const tracker = new TurnUsageTracker(reported);
    tracker.add(usage(10, 1), "m1");
    tracker.add(usage(10, 5), "m1");
    assert.deepEqual(tracker.total(), usage(10, 5));
  });

  it("reports only growth across a resumed bridge", () => {
    const reported = new Map<string, OpenAIUsage>([["m1", usage(10, 5)]]);
    const tracker = new TurnUsageTracker(reported);
    tracker.add(usage(10, 8), "m1");
    assert.deepEqual(tracker.total(), usage(10, 3));
  });

  it("sums completions across calls but takes the last prompt", () => {
    const tracker = new TurnUsageTracker(new Map());
    tracker.add(usage(10, 2), "m1");
    tracker.add(usage(20, 3), "m2");
    assert.deepEqual(tracker.total(), usage(20, 5));
  });

  it("falls back to the result usage", () => {
    assert.deepEqual(resolveTurnUsage(null, usage(7, 2)), usage(7, 2));
    assert.deepEqual(resolveTurnUsage(usage(3, 1), usage(7, 2)), usage(3, 1));
  });
});
