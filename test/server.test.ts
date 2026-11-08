import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseChatBody } from "../src/server.ts";

describe("parseChatBody", () => {
  it("rejects empty messages", () => {
    assert.throws(() => parseChatBody({ model: "x", messages: [] }), /No user/);
  });
  it("rejects invalid json shape", () => {
    assert.throws(() => parseChatBody(null), /Invalid/);
  });
  it("accepts minimal chat body", () => {
    const b = parseChatBody({ model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.equal(b.model, "m");
    assert.equal(b.messages.length, 1);
  });
});
