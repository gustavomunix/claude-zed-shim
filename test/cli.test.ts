import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { defaultMaxTokens, parseCliOptions } from "../src/cli.ts";

describe("parseCliOptions", () => {
  it("defaults: port 8124, provider claude-code", () => {
    const options = parseCliOptions([]);
    assert.equal(options.port, 8124);
    assert.equal(options.providerId, "claude-code");
    assert.equal(options.configDir, undefined);
  });
  it("parses --port --config-dir --provider-id", () => {
    const options = parseCliOptions(["--port", "8125", "--config-dir", "tmp", "--provider-id", "claude-code-2"]);
    assert.equal(options.port, 8125);
    assert.equal(options.configDir, resolve("tmp"));
    assert.equal(options.providerId, "claude-code-2");
  });
  it("throws on invalid provider id", () => {
    assert.throws(() => parseCliOptions(["--provider-id", "claude code"]), /provider/);
    assert.throws(() => parseCliOptions(["--provider-id", ""]), /provider/);
  });
  it("throws on invalid port", () => {
    assert.throws(() => parseCliOptions(["--port", "abc"]), /port/);
    assert.throws(() => parseCliOptions(["--port", "0"]), /port/);
  });
});

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
