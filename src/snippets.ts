import { defaultMaxTokens } from "./models.ts";
import type { ModelInfo } from "./server.ts";

export type SnippetFormat = "zed" | "opencode";

const OPENCODE_PACKAGE = "@opencode/ai/providers/openai-compatible";
const DEFAULT_OUTPUT_TOKENS = 64_000;

function openCodeModelKey(id: string): string {
  return id
    .replace(/:fast$/, "-fast")
    .replace(/\[1m\]/g, "-1m")
    .replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function outputTokens(model: ModelInfo): number {
  if (model.maxTokens && model.maxTokens > 0) return model.maxTokens;
  return model.id.toLowerCase().includes("claude") ? DEFAULT_OUTPUT_TOKENS : 1_000_000;
}

export function buildZedSnippet(models: ModelInfo[], port: number, providerId: string): unknown {
  return {
    language_models: {
      openai_compatible: {
        [providerId]: {
          api_url: `http://127.0.0.1:${port}/v1`,
          available_models: models.map((model) => ({
            name: model.id,
            display_name: model.displayName ?? model.id,
            max_tokens: defaultMaxTokens(model.id, model.contextWindow),
          })),
        },
      },
    },
  };
}

export function buildOpenCodeSnippet(models: ModelInfo[], port: number, providerId: string): unknown {
  const providerModels = Object.fromEntries(
    models.map((model) => [
      openCodeModelKey(model.id),
      {
        modelID: model.id,
        name: model.displayName ?? model.id,
        limit: {
          context: model.contextWindow ?? defaultMaxTokens(model.id),
          output: outputTokens(model),
        },
        capabilities: {
          tools: true,
          temperature: true,
          input: ["text", "image"],
        },
      },
    ]),
  );

  return {
    providers: {
      [providerId]: {
        name: `Claude (${providerId})`,
        package: OPENCODE_PACKAGE,
        settings: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "dummy",
        },
        models: providerModels,
      },
    },
  };
}
