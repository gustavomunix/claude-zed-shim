import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { debugLog } from "../src/log.ts";

const capture = (run: () => void): string[] => {
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return writes;
};

describe("debugLog", () => {
  it("stays silent when disabled", () => {
    const previous = process.env.CLAUDE_ZED_DEBUG;
    delete process.env.CLAUDE_ZED_DEBUG;
    try {
      assert.deepEqual(capture(() => debugLog("test", { a: 1 })), []);
    } finally {
      if (previous !== undefined) process.env.CLAUDE_ZED_DEBUG = previous;
    }
  });

  it("writes one JSON line and redacts sensitive keys", () => {
    const previous = process.env.CLAUDE_ZED_DEBUG;
    process.env.CLAUDE_ZED_DEBUG = "1";
    try {
      const writes = capture(() => debugLog("test", { a: 1, prompt: "secret" }));
      assert.equal(writes.length, 1);
      const line = JSON.parse(writes[0]!) as Record<string, unknown>;
      assert.equal(line.event, "test");
      assert.equal(line.a, 1);
      assert.equal(line.prompt, "[redacted]");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_ZED_DEBUG;
      else process.env.CLAUDE_ZED_DEBUG = previous;
    }
  });
});
