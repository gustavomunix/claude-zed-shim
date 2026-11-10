import { defaultMaxTokens } from "./models.ts";
import type { ModelInfo } from "./server.ts";

export type SnippetFormat = "zed" | "opencode";

const OPENCODE_PACKAGE = "@opencode/ai/providers/openai-compatible";
const DEFAULT_OUTPUT_TOKENS = 64_000;

function openCodeModelKey(id: string): string {
  const key = id
    .replace(/:fast$/, "-fast")
    .replace(/\[1m\]/g, "-1m")
    .replace(/[^a-zA-Z0-9_.-]/g, "-");
  return /^[a-zA-Z0-9]/.test(key) ? key : `model-${key.replace(/^[^a-zA-Z0-9]+/, "")}`;
}

function uniqueModelKey(id: string, used: Set<string>): string {
  const base = openCodeModelKey(id);
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(key);
  return key;
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
            ...(model.efforts?.length
              ? {
                  reasoning_effort: model.efforts.includes("high") ? "high" : model.efforts.at(-1),
                  reasoning_effort_levels: model.efforts,
                }
              : {}),
          })),
        },
      },
    },
  };
}

export function buildOpenCodeSnippet(models: ModelInfo[], port: number, providerId: string): unknown {
  const used = new Set<string>();
  const providerModels = Object.fromEntries(
    models.map((model) => {
      const context = model.contextWindow ?? defaultMaxTokens(model.id);
      return [
        uniqueModelKey(model.id, used),
        {
          modelID: model.id,
          name: model.displayName ?? model.id,
          limit: {
            context,
            output: Math.min(outputTokens(model), context),
          },
          capabilities: {
            tools: true,
            temperature: true,
            input: ["text", "image"],
          },
        },
      ];
    }),
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
