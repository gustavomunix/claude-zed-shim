import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./json-file.ts";
import { userHistoryFingerprints } from "./translate.ts";

type HistoryMessage = { role?: string; content?: unknown };

export function conversationKey(messages: HistoryMessage[], model: string): string {
  const system = messages
    .filter((m) => m?.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
  const prints = userHistoryFingerprints(messages);
  const root = prints[0] ?? "";
  const hash = createHash("sha1").update(`${model}\0${system}\0${root}`).digest("hex").slice(0, 24);
  return `zed:${hash}`;
}

export type TurnBoundary = {
  count: number;
  hash: string;
  leafUuid?: string;
  sessionId?: string;
};

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  leafUuid?: string;
  turns?: TurnBoundary[];
  updatedAt: number;
};

const MAX_TURN_BOUNDARIES = 100;

export function configBucket(): string {
  const cfgDir = (process.env.CLAUDE_CONFIG_DIR || "").trim();
  return cfgDir ? createHash("sha1").update(cfgDir).digest("hex").slice(0, 12) : "";
}

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "claude-zed-shim", configBucket(), "sessions.json");
}

export { storePath };

function readStore(): Record<string, ClaudeSessionBinding> {
  try {
    const parsed = readJsonFile<Record<string, ClaudeSessionBinding>>(storePath());
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  try {
    writeJsonFileAtomic(storePath(), store);
  } catch {
  }
}

export function getForeignSessionId(conversationKeyValue: string): string | undefined {
  return readStore()[conversationKeyValue]?.foreignSessionId;
}

export function setForeignSessionId(
  conversationKeyValue: string,
  sessionId: string,
  extra?: { modelId?: string; cwd?: string; leafUuid?: string },
): void {
  const store = readStore();
  const prev = store[conversationKeyValue];
  const turns = prev?.turns ?? [];
  store[conversationKeyValue] = {
    conversationKey: conversationKeyValue,
    foreignSessionId: sessionId,
    modelId: extra?.modelId ?? prev?.modelId,
    cwd: extra?.cwd ?? prev?.cwd,
    leafUuid: extra?.leafUuid ?? prev?.leafUuid,
    turns,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

export function clearForeignSessionId(conversationKeyValue: string): void {
  const store = readStore();
  if (store[conversationKeyValue]) {
    delete store[conversationKeyValue];
    writeStore(store);
  }
}

export function getSessionLeafUuid(conversationKeyValue: string): string | undefined {
  return readStore()[conversationKeyValue]?.leafUuid;
}

export function getSessionTurns(conversationKeyValue: string): TurnBoundary[] {
  return readStore()[conversationKeyValue]?.turns ?? [];
}

export function recordTurnStart(
  conversationKeyValue: string,
  boundary: TurnBoundary,
  _before?: TurnBoundary,
): void {
  const store = readStore();
  const binding = store[conversationKeyValue];
  if (!binding) return;
  const turns = [...(binding.turns ?? []), boundary].slice(-MAX_TURN_BOUNDARIES);
  store[conversationKeyValue] = { ...binding, turns, updatedAt: Date.now() };
  writeStore(store);
}

export function rewindSessionTurns(conversationKeyValue: string, index: number): void {
  const store = readStore();
  const binding = store[conversationKeyValue];
  if (!binding) return;
  store[conversationKeyValue] = { ...binding, turns: (binding.turns ?? []).slice(0, index + 1), updatedAt: Date.now() };
  writeStore(store);
}

export type HistoryMatch =
  | { kind: "untracked" }
  | { kind: "latest"; count: number }
  | { kind: "rewind"; index: number; leafUuid?: string; sessionId?: string }
  | { kind: "diverged" };

export function matchTurnHistory(turns: TurnBoundary[], prints: string[]): HistoryMatch {
  const latest = turns.at(-1);
  if (!latest) return { kind: "untracked" };
  const count = prints.length;
  if (count >= latest.count && prints[latest.count - 1] === latest.hash) {
    return { kind: "latest", count: latest.count };
  }
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.count === count && prints[count - 1] === turn.hash) {
      return {
        kind: "rewind",
        index: i,
        leafUuid: turn.leafUuid,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      };
    }
  }
  return { kind: "diverged" };
}
