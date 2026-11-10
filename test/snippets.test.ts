import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOpenCodeSnippet, buildZedSnippet } from "../src/snippets.ts";
import type { ModelInfo } from "../src/server.ts";

const models: ModelInfo[] = [
  { id: "claude-opus-5-5", displayName: "Opus 5.5", contextWindow: 1_000_000, maxTokens: 128_000 },
  { id: "claude-opus-5-5:fast", displayName: "Opus 5.5 Fast", contextWindow: 1_000_000, maxTokens: 128_000 },
];

describe("buildZedSnippet", () => {
  it("builds the openai-compatible provider block", () => {
    const snippet = buildZedSnippet(models, 8124, "claude-code") as {
      language_models: { openai_compatible: Record<string, { api_url: string; available_models: Array<{ name: string; max_tokens: number }> }> };
    };
    const provider = snippet.language_models.openai_compatible["claude-code"]!;
    assert.equal(provider.api_url, "http://127.0.0.1:8124/v1");
    assert.equal(provider.available_models[0]!.max_tokens, 1_000_000);
  });

  it("exposes effort levels when the model supports them", () => {
    const snippet = buildZedSnippet(
      [{ id: "claude-opus-5-5", contextWindow: 1_000_000, efforts: ["low", "medium", "high", "max"] }],
      8124,
      "claude-code",
    ) as { language_models: { openai_compatible: Record<string, { available_models: Array<Record<string, unknown>> }> } };
    const model = snippet.language_models.openai_compatible["claude-code"]!.available_models[0]!;
    assert.equal(model.reasoning_effort, "high");
    assert.deepEqual(model.reasoning_effort_levels, ["low", "medium", "high", "max"]);
  });
});

describe("buildOpenCodeSnippet", () => {
  it("builds the OpenCode v2 provider block", () => {
    const snippet = buildOpenCodeSnippet(models, 8125, "claude-code-2") as {
      providers: Record<string, {
        name: string;
        package: string;
        settings: { baseURL: string; apiKey: string };
        models: Record<string, { modelID: string; name: string; limit: { context: number; output: number } }>;
      }>;
    };
    const provider = snippet.providers["claude-code-2"]!;
    assert.equal(provider.name, "Claude (claude-code-2)");
    assert.equal(provider.package, "@opencode/ai/providers/openai-compatible");
    assert.equal(provider.settings.baseURL, "http://127.0.0.1:8125/v1");
    assert.equal(provider.models["claude-opus-5-5"]!.modelID, "claude-opus-5-5");
    assert.equal(provider.models["claude-opus-5-5-fast"]!.modelID, "claude-opus-5-5:fast");
    assert.deepEqual(provider.models["claude-opus-5-5"]!.limit, { context: 1_000_000, output: 128_000 });
  });

  it("keeps every model when keys collide and clamps output to context", () => {
    const snippet = buildOpenCodeSnippet(
      [
        { id: "a:b", displayName: "A", contextWindow: 10, maxTokens: 100 },
        { id: "a-b", displayName: "B", contextWindow: 10, maxTokens: 1 },
      ],
      8124,
      "p",
    ) as { providers: Record<string, { models: Record<string, { modelID: string; limit: { context: number; output: number } }> }> };
    const models = snippet.providers.p!.models;
    assert.equal(Object.keys(models).length, 2);
    assert.equal(Object.values(models)[0]!.limit.output, 10);
  });
});
