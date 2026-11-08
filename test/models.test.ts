import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelsFromSdk } from "../src/models.ts";

describe("modelsFromSdk", () => {
  it("dedupes alias + concrete, applies 1m default, adds fast neighbor", () => {
    const rows = [
      { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["high"], supportsFastMode: true },
      { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["high"], supportsFastMode: true },
      { value: "claude-sonnet-4-6[1m]", resolvedModel: "claude-sonnet-4-6", supportedEffortLevels: ["low"] },
    ];
    const models = modelsFromSdk(rows);
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("claude-opus-5-5"));
    assert.ok(ids.includes("claude-opus-5-5:fast"));
    assert.ok(ids.includes("claude-sonnet-4-6[1m]"));
    assert.equal(new Set(ids).size, ids.length);
  });
  it("skips default row", () => {
    assert.deepEqual(modelsFromSdk([{ value: "default" }]), []);
  });
});
