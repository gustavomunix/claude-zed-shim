import { fetchModelCatalog, startServer } from "./server.ts";
import { checkSubscriptionAuth } from "./auth.ts";
import { resolveClaudeCli } from "./cli-path.ts";
import { getClaudeModels } from "./models.ts";

export const DEFAULT_PORT = 8124;

export function defaultMaxTokens(id: string, catalogMax?: number): number {
  if (catalogMax && catalogMax > 0) return catalogMax;
  return id.toLowerCase().includes("claude") ? 200_000 : 1_000_000;
}

async function printModelsSnippet(port: number): Promise<void> {
  const models = await fetchModelCatalog();
  if (models.length === 0) {
    throw new Error("No Claude models found. Check `claude auth status` first.");
  }
  const snippet = {
    language_models: {
      openai_compatible: {
        "claude-code": {
          api_url: `http://127.0.0.1:${port}/v1`,
          available_models: models.map((m) => ({
            name: m.id,
            display_name: m.displayName ?? m.id,
            max_tokens: defaultMaxTokens(m.id, m.maxTokens),
          })),
        },
      },
    },
  };
  console.log(JSON.stringify(snippet, null, 2));
}

async function printStatus(): Promise<void> {
  const binary = await resolveClaudeCli();
  if (!binary) {
    console.log("Claude CLI: NOT FOUND (npm install -g @anthropic-ai/claude-code)");
    return;
  }
  console.log(`Claude CLI: ${binary}`);
  const refusal = await checkSubscriptionAuth();
  console.log(refusal ? `Auth: REFUSED — ${refusal}` : "Auth: OK (subscription)");
  console.log(`Models: ${getClaudeModels().length} (fallback catalog; run with login for live list)`);
}

function runSelfTest(): void {
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(`self-test failed: ${message}`);
  };
  assert(defaultMaxTokens("claude-opus-5-5", 0) === 200_000, "claude max");
  assert(defaultMaxTokens("other", 0) === 1_000_000, "other max");
  assert(defaultMaxTokens("x", 5) === 5, "catalog max");
  console.log("self-test: all checks passed");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "serve": {
      const portFlag = rest.indexOf("--port");
      const portRaw = portFlag >= 0 ? rest[portFlag + 1] : undefined;
      const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
      if (!Number.isFinite(port)) throw new Error("Invalid --port value");
      startServer(port);
      break;
    }
    case "models": {
      const portFlag = rest.indexOf("--port");
      const portRaw = portFlag >= 0 ? rest[portFlag + 1] : undefined;
      const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
      await printModelsSnippet(port);
      break;
    }
    case "status": {
      await printStatus();
      break;
    }
    case "self-test": {
      runSelfTest();
      break;
    }
    default: {
      console.log("Usage: cli.ts <serve [--port N] | models [--port N] | status | self-test>");
      process.exitCode = 1;
    }
  }
}

const invokedDirectly =
  process.argv[1] != null &&
  (process.argv[1].endsWith("cli.ts") ||
    process.argv[1].endsWith("cli.js") ||
    process.argv[1].replace(/\\/g, "/").endsWith("dist/cli.js"));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
