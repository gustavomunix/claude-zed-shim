import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolParameters, openZedToolName, zedToolName } from "../src/tool-bridge.ts";

describe("tool-bridge names", () => {
  it("roundtrips zed prefix", () => {
    assert.equal(zedToolName("read"), "mcp__zed__read");
    assert.equal(openZedToolName("mcp__zed__read"), "read");
    assert.equal(openZedToolName("other"), "other");
  });
  it("normalizes parameters to object schema", () => {
    assert.deepEqual(normalizeToolParameters(undefined), { type: "object", properties: {} });
    assert.deepEqual(normalizeToolParameters("nope"), { type: "object", properties: {} });
    const schema = { type: "object", properties: { q: { type: "string" } } };
    assert.deepEqual(normalizeToolParameters(schema), schema);
  });
});
