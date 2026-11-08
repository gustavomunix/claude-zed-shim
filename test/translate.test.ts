import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildConversationTranscript, extractTextContent, latestUserPrompt } from "../src/translate.ts";

describe("transcript", () => {
  it("orders system+user+assistant tool+tool result", () => {
    const messages = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "What is 2+2?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "calc", arguments: "{\"expr\":\"2+2\"}" } }],
      },
      { role: "tool", tool_call_id: "call-1", name: "calc", content: "{\"result\":4}" },
    ];
    const t = buildConversationTranscript(messages);
    assert.match(t, /Be concise/);
    assert.match(t, /What is 2\+2/);
    assert.match(t, /calc/);
    assert.match(t, /result/);
  });
  it("extracts text and latest prompt", () => {
    assert.equal(extractTextContent("hi"), "hi");
    assert.equal(extractTextContent([{ type: "text", text: "yo" }]), "yo");
    const p = latestUserPrompt([{ role: "user", content: "do x" }]);
    assert.equal(typeof p === "string" ? p : p.message.content, "do x");
  });
  it("keeps data-url image blocks", () => {
    const p = latestUserPrompt([
      {
        role: "user",
        content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
      },
    ]);
    assert.equal(typeof p === "string" ? "str" : (p.message.content as unknown[]).length, 2);
  });
});
