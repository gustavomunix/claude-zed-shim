import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCodeChildEnv } from "../src/env.ts";

describe("buildClaudeCodeChildEnv", () => {
  it("defaults MAX_MCP_OUTPUT_TOKENS when unset", () => {
    const env = buildClaudeCodeChildEnv({});
    assert.equal(env.MAX_MCP_OUTPUT_TOKENS, "200000");
  });

  it("keeps an existing MAX_MCP_OUTPUT_TOKENS", () => {
    const env = buildClaudeCodeChildEnv({ MAX_MCP_OUTPUT_TOKENS: "50000" });
    assert.equal(env.MAX_MCP_OUTPUT_TOKENS, "50000");
  });
});
