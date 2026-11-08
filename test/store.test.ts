import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conversationKey } from "../src/store.ts";

describe("conversationKey", () => {
  it("stable across turns with same initial message", () => {
    const a = [{ role: "user", content: "hello" }];
    const b = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "more" }];
    const ka = conversationKey(a, "m");
    const kb = conversationKey(b, "m");
    assert.equal(ka, kb);
  });
  it("changes when earlier message edited", () => {
    const a = conversationKey([{ role: "user", content: "hello" }], "m");
    const b = conversationKey([{ role: "user", content: "hello!" }], "m");
    assert.notEqual(a, b);
  });
  it("differs by model", () => {
    const msgs = [{ role: "user", content: "hello" }];
    assert.notEqual(conversationKey(msgs, "a"), conversationKey(msgs, "b"));
  });
});
