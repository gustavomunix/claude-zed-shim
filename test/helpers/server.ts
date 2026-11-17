import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setAuthStatusProbe } from "../../src/auth.ts";
import { clearAllBridges } from "../../src/pool.ts";
import { withGracefulStop, setClaudeQueryStarter, setClaudeSessionForker, type ClaudeQueryHandle, type StartClaudeQueryParams } from "../../src/sdk.ts";
import { startServer } from "../../src/server.ts";

export async function promptText(prompt: StartClaudeQueryParams["prompt"] | undefined): Promise<string> {
  if (typeof prompt === "string") return prompt;
  if (!prompt || typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") return String(prompt ?? "");
  const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const first = await iterator.next();
  const value = first.value as { message?: { content?: string | Array<{ text?: unknown }> } } | undefined;
  const content = value?.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .map((block) => (block && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function mockHandle(events: unknown[]): ClaudeQueryHandle {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    stream: (async function* () {
      for (const event of events) {
        for (const listener of listeners) listener(event);
        yield event;
      }
    })(),
    interrupt: async () => {},
    close: () => {},
    getPid: () => null,
    onEvent: (listener) => listeners.push(listener),
  };
}

export async function startTestServer() {
  const previousXdg = process.env.XDG_DATA_HOME;
  const previousCfg = process.env.CLAUDE_CONFIG_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), "claude-zed-server-data-"));
  const configDir = mkdtempSync(join(tmpdir(), "claude-zed-server-config-"));
  process.env.XDG_DATA_HOME = dataDir;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  setAuthStatusProbe(async () => null);

  const server = startServer(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    configDir,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await clearAllBridges();
      setAuthStatusProbe(null);
      setClaudeQueryStarter(null);
      setClaudeSessionForker(null);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousCfg;
    },
  };
}
