import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultMaxTokens } from "../src/cli.ts";

describe("defaultMaxTokens", () => {
  it("claude gets 200k", () => {
    assert.equal(defaultMaxTokens("claude-opus-5-5", 0), 200_000);
  });
  it("others get 1m", () => {
    assert.equal(defaultMaxTokens("gemini-x", 0), 1_000_000);
  });
  it("catalog max wins", () => {
    assert.equal(defaultMaxTokens("claude-x", 128_000), 128_000);
  });
});
