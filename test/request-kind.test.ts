import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMetaPrompt, detectMetaRequestKind } from "../src/request-kind.ts";

const system = (text: string) => [
  { role: "system", content: text },
  { role: "user", content: "the request" },
];

describe("detectMetaRequestKind", () => {
  it("recognizes Zed title, summary and commit prompts", () => {
    assert.equal(
      detectMetaRequestKind(system("Generate a concise 3-7 word title for this conversation, omitting punctuation.")),
      "title",
    );
    assert.equal(detectMetaRequestKind(system("Summarize the conversation so far to free up context.")), "summary");
    assert.equal(detectMetaRequestKind(system("Compact the conversation so far.")), "summary");
    assert.equal(detectMetaRequestKind(system("You are an expert at writing Git commits.")), "commit");
    assert.equal(detectMetaRequestKind(system("You are a coding agent.")), null);
  });

  it("builds an instructions prompt with the user request", () => {
    const prompt = buildMetaPrompt("commit", system("You are an expert at writing Git commits."));
    assert.match(prompt, /<instructions>/);
    assert.match(prompt, /the request/);
  });
});
