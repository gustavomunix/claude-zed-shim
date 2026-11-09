import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeZedTools, type ZedOpenAITool } from "../src/tool-bridge.ts";

const tool = (name: string): ZedOpenAITool => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

describe("describeZedTools", () => {
  it("marks only read-only tools for parallel execution", () => {
    const listed = describeZedTools([tool("read"), tool("webfetch"), tool("edit")]);
    assert.equal(listed.find((item) => item.name === "read")?.annotations?.readOnlyHint, true);
    assert.equal(listed.find((item) => item.name === "webfetch")?.annotations?.readOnlyHint, true);
    assert.equal(listed.find((item) => item.name === "edit")?.annotations, undefined);
  });

  it("keeps duplicate names with their own descriptions", () => {
    const first = tool("read");
    const second = tool("read");
    second.function!.description = "second";
    const listed = describeZedTools([first, second]);
    assert.deepEqual(
      listed.map((item) => item.description),
      ["read", "second"],
    );
  });
});
