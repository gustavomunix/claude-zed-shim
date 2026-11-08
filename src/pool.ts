import { withGracefulStop, type StoppableClaudeQueryHandle } from "./sdk.ts";
import type { ParkedToolCall } from "./tool-bridge.ts";

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  handle: StoppableClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  reportedUsage: Map<string, unknown>;
  forwardedSteering: Set<string>;
  createdAt: number;
  input?: { end: () => void };
  continueStream?: () => AsyncGenerator<unknown, void, unknown>;
  configDir?: string;
};

type BridgeRuntime = {
  bridges: Map<string, ParkedBridge>;
  stopping: Map<string, Set<Promise<void>>>;
  holders: number;
  shutdownTimer?: ReturnType<typeof setTimeout>;
};

const RUNTIME_KEY = Symbol.for("@claude-zed-shim/bridge-runtime/v1");

export const bridgeRuntime: BridgeRuntime = ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] ??= {
  bridges: new Map(),
  stopping: new Map(),
  holders: 0,
}) as BridgeRuntime;

const bridges = bridgeRuntime.bridges;

export function putBridge(bridge: ParkedBridge): void {
  for (const existing of [...bridges.values()]) {
    if (existing.conversationKey === bridge.conversationKey && existing.id !== bridge.id) {
      void stopBridge(existing.id, "Superseded by a newer turn");
    }
  }
  bridges.set(bridge.id, bridge);
}

export function getBridge(id: string): ParkedBridge | undefined {
  return bridges.get(id);
}

export function findBridgeByConversation(conversationKey: string): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function findBridgeByPendingTool(toolCallId: string): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.pendingTools.has(toolCallId)) return bridge;
  }
  return undefined;
}

function rejectPending(bridge: ParkedBridge, reason: string): void {
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error(reason));
  }
  bridge.pendingTools.clear();
}

export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  bridges.delete(id);
  rejectPending(bridge, "Bridge closed");
  bridge.handle.close();
  bridge.input?.end();
}

export function stopBridge(id: string, reason = "Bridge closed"): Promise<void> {
  const bridge = bridges.get(id);
  if (!bridge) return Promise.resolve();
  bridges.delete(id);
  const key = bridge.conversationKey;
  const stop = (async () => {
    try {
      await withGracefulStop(bridge.handle).stop();
    } finally {
      rejectPending(bridge, reason);
      bridge.input?.end();
    }
  })();
  let pending = bridgeRuntime.stopping.get(key);
  if (!pending) bridgeRuntime.stopping.set(key, (pending = new Set()));
  pending.add(stop);
  void stop.finally(() => {
    pending.delete(stop);
    if (pending.size === 0 && bridgeRuntime.stopping.get(key) === pending) bridgeRuntime.stopping.delete(key);
  });
  return stop;
}

export async function stopConversationBridges(conversationKey: string, reason?: string): Promise<number> {
  const ids = [...bridges.values()]
    .filter((bridge) => bridge.conversationKey === conversationKey)
    .map((bridge) => bridge.id);
  const started = ids.map((id) => stopBridge(id, reason));
  await Promise.all([...started, ...(bridgeRuntime.stopping.get(conversationKey) ?? [])]);
  return ids.length;
}

export async function clearAllBridges(): Promise<void> {
  await Promise.all([...bridges.keys()].map((id) => stopBridge(id)));
}

const spawnLocks = new Map<string, Promise<void>>();

export async function acquireSpawnLock(key: string): Promise<() => void> {
  const previous = spawnLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => held);
  spawnLocks.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (spawnLocks.get(key) === tail) spawnLocks.delete(key);
  };
}

export function parkedTurnTtlMs(): number | null {
  const raw = Number(process.env.CLAUDE_ZED_PARKED_TURN_TTL_MS ?? process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS);
  if (!Number.isFinite(raw) || raw < 0) return 3_600_000;
  return raw === 0 ? null : raw;
}

export function structuredOutputReapMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
}
