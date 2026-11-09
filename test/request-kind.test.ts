import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMetaPrompt, detectMetaRequestKind } from "../src/request-kind.ts";

const system = (text: string) => [
  { role: "system", content: text },
  { role: "user", content: "the request" },
];

describe("detectMetaRequestKind", () => {
  it("recognizes Zed title, summary and commit prompts", () => {
    const user = (text: string) => [{ role: "user", content: text }];
    assert.equal(
      detectMetaRequestKind(user("Generate a concise 3-7 word title for this conversation, omitting punctuation.")),
      "title",
    );
    assert.equal(detectMetaRequestKind(user("Summarize the conversation so far to free up context.")), "summary");
    assert.equal(detectMetaRequestKind(user("Compact the conversation so far.")), "summary");
    assert.equal(detectMetaRequestKind(user("You are an expert at writing Git commits.")), "commit");
    assert.equal(detectMetaRequestKind(user("You are a coding agent.")), null);
  });

  it("recognizes markers in the last user message", () => {
    assert.equal(
      detectMetaRequestKind([{ role: "user", content: "Generate a concise 3-7 word title for this conversation" }]),
      "title",
    );
    assert.equal(
      detectMetaRequestKind([{ role: "user", content: "Generate a detailed summary of this conversation" }]),
      "summary",
    );
    assert.equal(
      detectMetaRequestKind([{ role: "user", content: "You are compacting this conversation into a handoff" }]),
      "summary",
    );
  });

  it("ignores markers left in older history or project rules", () => {
    assert.equal(
      detectMetaRequestKind([
        { role: "user", content: "Generate a concise 3-7 word title for this conversation" },
        { role: "assistant", content: "A title" },
        { role: "user", content: "normal follow-up" },
      ]),
      null,
    );
    assert.equal(
      detectMetaRequestKind([
        { role: "system", content: "You are an expert at writing Git commits." },
        { role: "user", content: "normal follow-up" },
      ]),
      null,
    );
  });

  it("builds an instructions prompt with the user request", () => {
    const prompt = buildMetaPrompt("commit", system("You are an expert at writing Git commits."));
    assert.match(prompt, /<instructions>/);
    assert.match(prompt, /the request/);
  });

  it("includes prior conversation for title and summary", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "Generate a concise 3-7 word title for this conversation" },
    ];
    const prompt = buildMetaPrompt("title", messages);
    assert.match(prompt, /first question/);
    assert.match(prompt, /first answer/);
    assert.match(prompt, /Generate a concise/);
  });

  it("keeps a trailing user turn before the instruction", () => {
    const prompt = buildMetaPrompt("title", [
      { role: "user", content: "now add tests" },
      { role: "user", content: "Generate a concise 3-7 word title for this conversation" },
    ]);
    assert.match(prompt, /now add tests/);
  });
});
