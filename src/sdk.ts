import { spawnSync } from "node:child_process";
import { buildClaudeCodeChildEnv } from "./env.ts";
import { assertClaudeWorkingDirectory, isJsEntrypoint, resolveClaudeCodeExecutable } from "./cli-path.ts";

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkModulePromise: Promise<SdkModule> | null = null;
let sdkLoadError: Error | null = null;
let sdkModule: SdkModule | null = null;

const ALLOWED_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

const trimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : null;
}

export async function loadClaudeAgentSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@anthropic-ai/claude-agent-sdk")
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError =
          error instanceof Error
            ? error
            : new Error(String((error as { message?: string })?.message || error || "Failed to load Claude Agent SDK"));
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

export async function forkClaudeSession(sessionId: string, upToMessageId: string): Promise<string> {
  const sdk = await loadClaudeAgentSdk();
  const result = await sdk.forkSession(sessionId, { upToMessageId });
  if (!result?.sessionId) throw new Error("forkSession returned no session id");
  return result.sessionId;
}

export function resetClaudeAgentSdkCache(): void {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

export function killProcessTree(
  pid: number | null | undefined,
  options: { signal?: NodeJS.Signals; force?: boolean } = {},
): void {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return;
  const signal = options.signal || "SIGTERM";
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
    }
    return;
  }
  const kill = (target: number, killSignal: NodeJS.Signals) => {
    try {
      process.kill(target, killSignal);
    } catch {
    }
  };
  kill(-pid, signal);
  kill(pid, signal);
  if (options.force) {
    kill(-pid, "SIGKILL");
    kill(pid, "SIGKILL");
  }
}

export type ClaudeQueryHandle = {
  stream: AsyncIterable<unknown>;
  interrupt: () => Promise<void>;
  close: () => void;
  getPid: () => number | null | undefined;
  stop?: (graceMs?: number) => Promise<void>;
  onEvent?: (listener: (event: unknown) => void) => void;
};

export type StoppableClaudeQueryHandle = ClaudeQueryHandle & {
  stop: (graceMs?: number) => Promise<void>;
  onEvent: (listener: (event: unknown) => void) => void;
};

export function stopGraceMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_STOP_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2_000;
}

export function withGracefulStop(handle: ClaudeQueryHandle): StoppableClaudeQueryHandle {
  if (typeof handle.stop === "function" && typeof handle.onEvent === "function") {
    return handle as StoppableClaudeQueryHandle;
  }
  const inner = handle.stream[Symbol.asyncIterator]();
  const listeners: Array<(event: unknown) => void> = [];
  let ended = false;
  let sawResult = false;
  const observe = (event: unknown) => {
    if (event && typeof event === "object" && (event as { type?: unknown }).type === "result") {
      sawResult = true;
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  };
  const tap: AsyncIterableIterator<unknown> = {
    async next() {
      try {
        const next = await inner.next();
        if (next.done) ended = true;
        else observe(next.value);
        return next;
      } catch (error) {
        ended = true;
        throw error;
      }
    },
    async return(value?: unknown) {
      ended = true;
      if (typeof inner.return === "function") return inner.return(value);
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return tap;
    },
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    handle.close();
  };

  let stopping: Promise<void> | null = null;
  const stop = (graceMs = stopGraceMs()) => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!closed && !ended && graceMs > 0) {
        const settle = (async () => {
          try {
            await handle.interrupt();
          } catch {
            return;
          }
          while (!ended && !sawResult && !closed) {
            try {
              if ((await tap.next()).done) break;
            } catch {
              break;
            }
          }
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          settle,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, graceMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      close();
    })();
    return stopping;
  };

  return {
    stream: tap,
    interrupt: handle.interrupt,
    close,
    getPid: handle.getPid,
    stop,
    onEvent: (listener) => {
      listeners.push(listener);
    },
  };
}

export type StartClaudeQueryParams = {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  model?: string;
  resume?: string;
  resumeSessionAt?: string;
  forkSession?: boolean;
  permissionMode?: string;
  effort?: string;
  fastMode?: boolean;
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string; excludeDynamicSections?: boolean };
  canUseTool?: (toolName: string, input: Record<string, unknown>, options: object) => Promise<object | null>;
  env?: Record<string, string | undefined>;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, object>;
  agent?: string;
  allowedTools?: string[];
  tools?: string[] | { type: string; [key: string]: unknown };
  toolAliases?: Record<string, string>;
  disallowedTools?: string[];
  skills?: string[] | "all";
  settingSources?: Array<"user" | "project" | "local">;
  pathToClaudeCodeExecutable?: string;
  allowDangerouslySkipPermissions?: boolean;
  autoCompactEnabled?: boolean;
  maxTurns?: number;
  persistSession?: boolean;
  isolateMcp?: boolean;
  thinking?: { type: "adaptive" } | { type: "enabled"; budgetTokens: number } | { type: "disabled" };
  queryImpl?: (mod: SdkModule) => unknown;
};

export async function startClaudeQuery(params: StartClaudeQueryParams): Promise<ClaudeQueryHandle> {
  const sdk = await loadClaudeAgentSdk();
  const queryFn =
    typeof params.queryImpl === "function" ? params.queryImpl(sdk) : (sdk as { query?: unknown }).query;

  if (typeof queryFn !== "function") {
    const error = new Error("Claude Agent SDK query() is unavailable") as Error & {
      code?: string;
      statusCode?: number;
    };
    error.code = "CLAUDE_SDK_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable =
    trimmedString(params.pathToClaudeCodeExecutable) ||
    (await resolveClaudeCodeExecutable({ env })) ||
    undefined;

  const options: Record<string, unknown> = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
    settingSources: Array.isArray(params.settingSources) ? params.settingSources : ["user", "project", "local"],
  };

  if (pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    if (isJsEntrypoint(pathToClaudeCodeExecutable)) options.executable = "node";
  }

  const model = trimmedString(params.model);
  if (model) options.model = model;

  const resume = trimmedString(params.resume);
  if (resume) {
    options.resume = resume;
    const resumeAt = trimmedString(params.resumeSessionAt);
    if (resumeAt) options.resumeSessionAt = resumeAt;
    if (params.forkSession === true) options.forkSession = true;
  }

  const permissionMode = trimmedString(params.permissionMode);
  if (ALLOWED_PERMISSION_MODES.has(permissionMode)) {
    options.permissionMode = permissionMode;
  }
  if (params.allowDangerouslySkipPermissions === true && permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }

  if (params.thinking) {
    options.thinking = params.thinking;
  }

  if (params.autoCompactEnabled !== false) {
    options.autoCompactEnabled = true;
  }

  if (params.persistSession === false) options.persistSession = false;

  const settings: Record<string, unknown> = {};
  if (params.isolateMcp === true) {
    options.strictMcpConfig = true;
    settings.disableClaudeAiConnectors = true;
  }

  if ((options.thinking as { type?: string } | undefined)?.type !== "disabled") {
    settings.showThinkingSummaries = true;
    options.extraArgs = { "thinking-display": "summarized" };
  }

  if (params.fastMode === true) settings.fastMode = true;

  if (Object.keys(settings).length > 0) options.settings = settings;

  if (Number.isInteger(params.maxTurns) && Number(params.maxTurns) > 0) {
    options.maxTurns = params.maxTurns;
  }

  if (typeof params.canUseTool === "function") {
    options.canUseTool = params.canUseTool;
  }

  const customSystemPrompt = trimmedString(params.systemPrompt);
  const presetSystemPrompt = typeof params.systemPrompt === "string" ? null : nonEmptyRecord(params.systemPrompt);
  if (customSystemPrompt) {
    options.systemPrompt = customSystemPrompt;
  } else if (presetSystemPrompt?.type === "preset" && presetSystemPrompt.preset === "claude_code") {
    const systemPrompt: { type: "preset"; preset: "claude_code"; append?: string; excludeDynamicSections?: boolean } = {
      type: "preset",
      preset: "claude_code",
    };
    const append = trimmedString(presetSystemPrompt.append);
    if (append) systemPrompt.append = append;
    if (presetSystemPrompt.excludeDynamicSections === true) {
      systemPrompt.excludeDynamicSections = true;
    }
    options.systemPrompt = systemPrompt;
  } else {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }

  if (nonEmptyRecord(params.mcpServers)) options.mcpServers = params.mcpServers;
  if (nonEmptyRecord(params.agents)) options.agents = params.agents;

  const mainAgent = trimmedString(params.agent);
  if (mainAgent) options.agent = mainAgent;

  if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
    options.allowedTools = params.allowedTools.filter((tool) => typeof tool === "string" && tool.trim());
  }

  if (Array.isArray(params.disallowedTools) && params.disallowedTools.length > 0) {
    options.disallowedTools = params.disallowedTools.filter((tool) => typeof tool === "string" && tool.trim());
  }

  if (params.tools !== undefined) {
    options.tools = params.tools;
  }

  if (nonEmptyRecord(params.toolAliases)) {
    options.toolAliases = params.toolAliases;
  }

  if (params.skills === "all" || Array.isArray(params.skills)) {
    options.skills = params.skills;
  } else if (params.skills === undefined) {
    options.skills = "all";
  }

  let result: any;
  try {
    result = (queryFn as (input: { prompt: unknown; options: unknown }) => unknown)({
      prompt: params.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error("Claude Code executable path is not spawnable (ENOTDIR).") as Error & {
        code?: string;
        statusCode?: number;
        cause?: unknown;
      };
      wrapped.code = "CLAUDE_SPAWN_ENOTDIR";
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const getPid = () =>
    result && typeof result === "object" && "pid" in result
      ? (result.pid as number | null | undefined)
      : null;

  const interrupt = async () => {
    if (result && typeof result.interrupt === "function") {
      await result.interrupt();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    killProcessTree(getPid(), { signal: "SIGTERM", force: true });
    if (result && typeof result.close === "function") {
      try {
        result.close();
      } catch {
      }
    }
    if (result && typeof result.return === "function") {
      try {
        Promise.resolve(result.return()).catch(() => {});
      } catch {
      }
    }
  };

  return withGracefulStop({
    stream: result as AsyncIterable<unknown>,
    interrupt,
    close,
    getPid,
  });
}

export async function listClaudeSupportedModels(timeoutMs = 20_000): Promise<unknown[] | null> {
  const sdk = await loadClaudeAgentSdk();
  const queryFn = (sdk as { query?: Function }).query;
  if (typeof queryFn !== "function") return null;
  let release: () => void = () => {};
  const idle = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const env = buildClaudeCodeChildEnv(process.env);
  const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutable({ env });
  const q = queryFn({
    prompt: idle,
    options: {
      env,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      ...(pathToClaudeCodeExecutable && isJsEntrypoint(pathToClaudeCodeExecutable) ? { executable: "node" as const } : {}),
    },
  }) as { supportedModels?: () => Promise<unknown[]>; close?: () => void };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof q.supportedModels !== "function") return null;
    return await Promise.race([
      q.supportedModels(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    q.close?.();
  }
}
