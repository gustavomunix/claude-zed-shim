import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, ClaudeSessionBinding>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(store, null, 2));
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
  | { kind: "latest"; count: number }
  | { kind: "rewind"; index: number; leafUuid?: string; sessionId?: string }
  | { kind: "diverged" };

export function matchTurnHistory(turns: TurnBoundary[], prints: string[]): HistoryMatch {
  if (turns.length === 0 || prints.length === 0) {
    return { kind: "latest", count: Math.min(turns.length, prints.length) };
  }
  let matched = 0;
  for (let i = 0; i < Math.min(turns.length, prints.length); i++) {
    if (turns[i]!.hash === prints[i]) matched = i + 1;
    else break;
  }
  if (matched === prints.length && matched <= turns.length) {
    return { kind: "latest", count: matched };
  }
  if (matched > 0 && matched < prints.length) {
    const boundary = turns[matched - 1]!;
    return { kind: "rewind", index: matched - 1, leafUuid: boundary.leafUuid, sessionId: boundary.sessionId };
  }
  if (matched === 0 && prints.length > 0) {
    return { kind: "diverged" };
  }
  return { kind: "latest", count: matched };
}
