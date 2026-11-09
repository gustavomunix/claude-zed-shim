import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fetchModelCatalog, startServer } from "./server.ts";
import { checkSubscriptionAuth } from "./auth.ts";
import { resolveClaudeCli } from "./cli-path.ts";
import { defaultMaxTokens, getClaudeModels, invalidateModelsCache } from "./models.ts";
import { buildOpenCodeSnippet, buildZedSnippet, type SnippetFormat } from "./snippets.ts";

export { defaultMaxTokens } from "./models.ts";

export const DEFAULT_PORT = 8124;
export const DEFAULT_PROVIDER_ID = "claude-code";
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export type CliOptions = {
  port: number;
  configDir?: string;
  providerId: string;
  format: SnippetFormat;
};

export function parseCliOptions(rest: string[]): CliOptions {
  const portFlag = rest.indexOf("--port");
  const portRaw = portFlag >= 0 ? rest[portFlag + 1] : undefined;
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid --port value");

  const dirFlag = rest.indexOf("--config-dir");
  const dirRaw = dirFlag >= 0 ? rest[dirFlag + 1] : undefined;

  const idFlag = rest.indexOf("--provider-id");
  const idRaw = idFlag >= 0 ? rest[idFlag + 1] : undefined;
  const providerId = idFlag >= 0 ? (idRaw ?? "") : DEFAULT_PROVIDER_ID;
  if (!PROVIDER_ID_PATTERN.test(providerId)) throw new Error("Invalid --provider-id value");

  const formatFlag = rest.indexOf("--format");
  const formatRaw = formatFlag >= 0 ? rest[formatFlag + 1] : undefined;
  const format = formatFlag >= 0 ? formatRaw : "zed";
  if (format !== "zed" && format !== "opencode") throw new Error("Invalid --format value");

  return { port, configDir: dirRaw ? resolve(dirRaw.trim()) : undefined, providerId, format };
}

function applyConfigDir(configDir: string | undefined): void {
  if (!configDir) return;
  mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
  invalidateModelsCache();
}

async function printModelsSnippet(
  port: number,
  providerId: string = DEFAULT_PROVIDER_ID,
  format: SnippetFormat = "zed",
): Promise<void> {
  const models = await fetchModelCatalog();
  if (models.length === 0) {
    throw new Error("No Claude models found. Check `claude auth status` first.");
  }
  const snippet = format === "opencode" ? buildOpenCodeSnippet(models, port, providerId) : buildZedSnippet(models, port, providerId);
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
      const options = parseCliOptions(rest);
      applyConfigDir(options.configDir);
      if (options.configDir) console.log(`Account config dir: ${options.configDir}`);
      startServer(options.port);
      break;
    }
    case "models": {
      const options = parseCliOptions(rest);
      applyConfigDir(options.configDir);
      await printModelsSnippet(options.port, options.providerId, options.format);
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
