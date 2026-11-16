import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  answeredToolStepIndex,
  answeredToolStepPrompt,
  attachPromotedToolMedia,
  buildConversationTranscript,
  decodeToolMessageContent,
  extractTextContent,
  finishReasonFor,
  latestUserPrompt,
  openaiToolResultToMcpContent,
  promptAsStream,
} from "../src/translate.ts";

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
  it("maps claude stop reasons", () => {
    assert.equal(finishReasonFor("max_tokens"), "length");
    assert.equal(finishReasonFor("refusal"), "content_filter");
    assert.equal(finishReasonFor("end_turn"), "stop");
    assert.equal(finishReasonFor(undefined), "stop");
  });
  it("keeps data-url image blocks", () => {
    const p = latestUserPrompt([
      {
        role: "user",
        content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;name=photo.png;base64,AAA" } }],
      },
    ]);
    assert.equal(typeof p === "string" ? "str" : (p.message.content as unknown[]).length, 2);
  });
  it("converts diverse multimodal and file parts", () => {
    const p = latestUserPrompt([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "JPEGDATA" } },
          { type: "input_image", data: "PNGDATA" },
          { type: "file", file_data: "data:application/pdf;base64,PDFDATA", filename: "doc.pdf" },
          { type: "text", text: "analyze these" },
        ],
      },
    ]);
    assert.ok(typeof p !== "string");
    const blocks = p.message.content as any[];
    assert.equal(blocks.length, 4);
    assert.equal(blocks[0].type, "image");
    assert.equal(blocks[0].source.media_type, "image/jpeg");
    assert.equal(blocks[1].type, "image");
    assert.equal(blocks[2].type, "document");
    assert.equal(blocks[2].source.media_type, "application/pdf");
    assert.equal(blocks[3].type, "text");
    assert.equal(blocks[3].text, "analyze these");
  });
  it("decodes tool content parts and attaches promoted media", () => {
    const jsonParts = JSON.stringify([
      { type: "text", text: "captured screenshot" },
      { type: "file", uri: "data:image/png;base64,IMGDATA", mime: "image/png" },
    ]);
    const decoded = decodeToolMessageContent(jsonParts);
    assert.ok(Array.isArray(decoded));
    const mcp = openaiToolResultToMcpContent(decoded);
    assert.equal(mcp.length, 2);
    assert.equal(mcp[0]?.type, "text");
    assert.equal(mcp[1]?.type, "image");

    const toolResults = new Map([["call-1", [{ type: "text" as const, text: "ok" }]]]);
    const messages = [
      { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "screenshot" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,PROMOTED" } }] },
    ];
    const attached = attachPromotedToolMedia(messages, toolResults);
    assert.equal(attached, 1);
    const updated = toolResults.get("call-1")!;
    assert.equal(updated.length, 2);
    assert.equal(updated[1]?.type, "image");
  });
  it("streams SdkUserPrompt via promptAsStream", async () => {
    const prompt = {
      type: "user" as const,
      message: { role: "user" as const, content: [{ type: "text" as const, text: "test" }] },
      parent_tool_use_id: null,
    };
    const stream = promptAsStream(prompt);
    const items = [];
    for await (const item of stream) items.push(item);
    assert.equal(items.length, 1);
    assert.equal(items[0], prompt);
  });
  it("rebuilds prompt for answered tool step when no park exists", () => {
    const messages = [
      { role: "user", content: "take picture" },
      {
        role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "call-99", function: { name: "camera", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-99",
        name: "camera",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,CAMDATA" } }],
      },
    ];
    const idx = answeredToolStepIndex(messages);
    assert.equal(idx, 1);
    const rebuilt = answeredToolStepPrompt(messages, idx!);
    assert.equal(rebuilt.type, "user");
    assert.ok(Array.isArray(rebuilt.message.content));
    assert.ok((rebuilt.message.content as any[]).some((b) => b.type === "image"));
  });
});
