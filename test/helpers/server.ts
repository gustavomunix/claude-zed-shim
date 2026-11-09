import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setAuthStatusProbe } from "../../src/auth.ts";
import { clearAllBridges } from "../../src/pool.ts";
import { setClaudeQueryStarter, setClaudeSessionForker, type ClaudeQueryHandle } from "../../src/sdk.ts";
import { startServer } from "../../src/server.ts";

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
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
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
