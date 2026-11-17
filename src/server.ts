import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { checkSubscriptionAuth } from "./auth.ts";
import { buildClaudeCodeChildEnv } from "./env.ts";
import { debugLog } from "./log.ts";
import { getClaudeModels, isFastModelId, refreshModelsFromCli, resolveClaudeModelId } from "./models.ts";
import {
  buildZedMcpServer,
  buildToolAliases,
  openZedToolName,
  type ParkedToolCall,
  type ZedOpenAITool,
} from "./tool-bridge.ts";
import {
  answeredToolStepIndex,
  answeredToolStepPrompt,
  attachPromotedToolMedia,
  buildConversationTranscript,
  classifyClaudeFailure,
  decodeToolMessageContent,
  failureStatusFor,
  finishReasonFor,
  latestUserPrompt,
  openAICompletion,
  openAIError,
  openaiToolResultToMcpContent,
  priorMessagesOf,
  promptAsStream,
  usageFromAnthropic,
  usageFromSdkResult,
  userHistoryFingerprints,
  withConversationContext,
  type McpToolResultContent,
  type SdkUserPrompt,
} from "./translate.ts";
import {
  acquireSpawnLock,
  clearAllBridges,
  deleteBridge,
  findBridgeByConversation,
  findBridgeByPendingTool,
  parkedTurnTtlMs,
  putBridge,
  stopBridge,
  stopConversationBridges,
  type ParkedBridge,
} from "./pool.ts";
import {
  clearForeignSessionId,
  conversationKey,
  getForeignSessionId,
  getSessionLeafUuid,
  getSessionTurns,
  matchTurnHistory,
  recordTurnStart,
  rewindSessionTurns,
  setForeignSessionId,
} from "./store.ts";
import { planResume, type SessionFileProbe } from "./resume.ts";
import {
  buildMetaPrompt,
  detectMetaRequestKind,
  UTILITY_SYSTEM_PROMPT,
  type MetaRequestKind,
} from "./request-kind.ts";
import { TurnUsageTracker, resolveTurnUsage, type OpenAIUsage } from "./usage.ts";
import {
  findClaudeSessionFile,
  lastChainEntryUuid,
  sessionChainAfterLeaf,
  sessionFileHasEntry,
} from "./session-transcript.ts";
import {
  getClaudeQueryStarter,
  getClaudeSessionForker,
  withGracefulStop,
  type StoppableClaudeQueryHandle,
} from "./sdk.ts";

const MAX_BODY_BYTES = 128 * 1024 * 1024;
const PARK_QUIET_MS = 3_000;
const PARK_SETTLE_MS = 300;

function turnStallMs(): number {
  const raw = Number(process.env.CLAUDE_ZED_TURN_STALL_MS ?? process.env.OPENCODE_CLAUDE_TURN_STALL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 600_000;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const { status: s, body } = openAIError(status, message);
  res.writeHead(s, { "Content-Type": "application/json" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export type ZedMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
};

export type ChatBody = {
  model: string;
  messages: ZedMessage[];
  tools: ZedOpenAITool[];
  stream: boolean;
  reasoning_effort?: string;
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
};

export function parseResponseFormat(raw: unknown): ChatBody["outputFormat"] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new Error("response_format must be an object");
  const rf = raw as Record<string, unknown>;
  if (rf.type !== "json_schema") {
    throw new Error('response_format must be { type: "json_schema", json_schema: { schema } }; other formats are not supported');
  }
  const jsonSchema =
    rf.json_schema && typeof rf.json_schema === "object" ? (rf.json_schema as Record<string, unknown>) : rf;
  const schema = jsonSchema.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("response_format json_schema requires a schema object");
  }
  return { type: "json_schema", schema: schema as Record<string, unknown> };
}

export function parseChatBody(raw: unknown): ChatBody {
  if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
  const body = raw as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? (body.messages as ZedMessage[]) : [];
  if (messages.length === 0) throw new Error("No user/model content to send");
  const reasoning =
    body.reasoning && typeof body.reasoning === "object" ? (body.reasoning as { effort?: unknown }) : undefined;
  const reasoningEffort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort
      : typeof reasoning?.effort === "string"
        ? reasoning.effort
        : undefined;
  const toolChoice = body.tool_choice;
  const toolChoiceNone =
    toolChoice === "none" ||
    (toolChoice && typeof toolChoice === "object" && (toolChoice as { type?: unknown }).type === "none");
  return {
    model: typeof body.model === "string" && body.model ? body.model : "sonnet",
    messages,
    tools: Array.isArray(body.tools) ? (body.tools as ZedOpenAITool[]) : [],
    stream: body.stream !== false,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(toolChoiceNone ? { tool_choice: "none" as const } : {}),
    ...(body.parallel_tool_calls === false ? { parallel_tool_calls: false as const } : {}),
    ...(parseResponseFormat(body.response_format) ? { outputFormat: parseResponseFormat(body.response_format) } : {}),
  };
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  efforts?: string[];
}

export async function fetchModelCatalog(): Promise<ModelInfo[]> {
  await refreshModelsFromCli().catch(() => {});
  return getClaudeModels().map((m) => ({
    id: m.id,
    displayName: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    efforts: m.efforts,
  }));
}

async function handleModels(res: ServerResponse): Promise<void> {
  try {
    const models = await fetchModelCatalog();
    sendJson(res, 200, {
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "claude-zed-shim" })),
    });
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : String(error));
  }
}

async function handleHealth(res: ServerResponse): Promise<void> {
  try {
    const models = await fetchModelCatalog();
    sendJson(res, 200, { status: "ok", provider: "claude-zed-shim", models: models.length });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

function collectToolResults(messages: ZedMessage[]): Map<string, McpToolResultContent[]> {
  const results = new Map<string, McpToolResultContent[]>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.tool_call_id) continue;
    results.set(msg.tool_call_id, openaiToolResultToMcpContent(decodeToolMessageContent(msg.content)));
  }
  return results;
}

function cwdFromEnv(): string {
  return process.env.CLAUDE_ZED_CWD || process.cwd();
}

// --- SDK event mapping (simplified from proxy.ts mapSdkEvent) ---

type MappedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "park"; tools: ParkedToolCall[] }
  | { kind: "usage-delta"; usage: OpenAIUsage; messageId: string | null }
  | { kind: "usage"; usage: OpenAIUsage; structured?: unknown }
  | { kind: "retry"; attempt: number; maxRetries: number; delayMs: number; status: number | null }
  | { kind: "error"; text: string }
  | { kind: "ignore" };

type MapState = { messageId: string | null; stopReason?: string; producedContent?: boolean; heldThinking?: { index: number; text: string; narration: boolean; first: boolean } };

function usageFromAssistantEvent(event: unknown): OpenAIUsage | null {
  const e = event as { message?: { usage?: unknown } };
  if (!e?.message || typeof e.message !== "object") return null;
  const u = (e.message as { usage?: unknown }).usage;
  if (!u || typeof u !== "object") return null;
  return usageFromAnthropic(u as Record<string, unknown>);
}

export function isNarrationSignature(signature: unknown): boolean {
  return typeof signature === "string" && Buffer.from(signature, "base64").subarray(0, 64).includes("narration");
}

function mapSdkEvent(event: unknown, state: MapState): MappedEvent {
  if (!event || typeof event !== "object") return { kind: "ignore" };
  const e = event as Record<string, unknown>;
  if (e.type === "__park__" && Array.isArray(e.tools)) {
    state.producedContent = true;
    return { kind: "park", tools: e.tools as ParkedToolCall[] };
  }
  if (e.type === "system" && e.subtype === "api_retry") {
    return {
      kind: "retry",
      attempt: typeof e.attempt === "number" && Number.isFinite(e.attempt) ? e.attempt : 0,
      maxRetries: typeof e.max_retries === "number" && Number.isFinite(e.max_retries) ? e.max_retries : 0,
      delayMs: typeof e.retry_delay_ms === "number" && Number.isFinite(e.retry_delay_ms) ? e.retry_delay_ms : 0,
      status: typeof e.error_status === "number" ? e.error_status : null,
    };
  }
  if (e.type === "result") {
    if (!e.parent_tool_use_id && typeof e.stop_reason === "string") state.stopReason = e.stop_reason;
    if (e.fast_mode_state || e.fast_mode_disabled_reason) {
      debugLog("fast_mode", { state: e.fast_mode_state, disabled_reason: e.fast_mode_disabled_reason });
    }
    if (e.is_error) {
      const fromErrors = Array.isArray(e.errors)
        ? e.errors.find((item) => typeof item === "string" && item.length > 0)
        : null;
      const text =
        (typeof fromErrors === "string" && fromErrors) ||
        (typeof e.error === "string" ? e.error : typeof e.result === "string" ? e.result : "Claude turn failed");
      return { kind: "error", text };
    }
    const usage = usageFromSdkResult(event);
    if (usage) return { kind: "usage", usage, structured: e.structured_output };
    return { kind: "ignore" };
  }
  if (e.type === "stream_event" && e.event && typeof e.event === "object") {
    const ev = e.event as Record<string, unknown>;
    if (ev.type === "message_start" && ev.message && typeof ev.message === "object") {
      const message = ev.message as { id?: unknown; usage?: unknown };
      const id = typeof message.id === "string" ? message.id : null;
      state.messageId = id;
      const usage = message.usage && typeof message.usage === "object" ? usageFromAnthropic(message.usage as Record<string, unknown>) : null;
      return usage ? { kind: "usage-delta", usage, messageId: id } : { kind: "ignore" };
    }
    if (ev.type === "message_delta") {
      const stopReason = (ev.delta as { stop_reason?: unknown } | undefined)?.stop_reason;
      if (typeof stopReason === "string" && !e.parent_tool_use_id) state.stopReason = stopReason;
      const usage = ev.usage && typeof ev.usage === "object" ? usageFromAnthropic(ev.usage as Record<string, unknown>) : null;
      return usage ? { kind: "usage-delta", usage, messageId: state.messageId } : { kind: "ignore" };
    }
    const held = state.heldThinking?.index === ev.index ? state.heldThinking : undefined;
    if (ev.type === "content_block_start" && typeof ev.index === "number" && (ev.content_block as { type?: unknown } | undefined)?.type === "thinking") {
      state.heldThinking = { index: ev.index, text: "", narration: false, first: ev.index === 0 };
      return { kind: "ignore" };
    }
    if (ev.type === "content_block_stop" && held) {
      state.heldThinking = undefined;
      if (!held.text) return { kind: "ignore" };
      if (!held.narration) return { kind: "reasoning", text: held.text };
      state.producedContent = true;
      return { kind: "text", text: held.text };
    }
    if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
      const delta = ev.delta as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (delta.text) state.producedContent = true;
        return { kind: "text", text: delta.text };
      }
      if ((delta.type === "thinking_delta" || delta.type === "reasoning_delta") && typeof (delta.thinking ?? delta.text) === "string") {
        const text = String(delta.thinking ?? delta.text);
        if (held) {
          held.text += text;
          return { kind: "ignore" };
        }
        return { kind: "reasoning", text };
      }
      if (delta.type === "signature_delta" && held) {
        held.narration = isNarrationSignature(delta.signature);
      }
    }
    return { kind: "ignore" };
  }
  if (e.type === "assistant") {
    const usage = usageFromAssistantEvent(event);
    if (usage) return { kind: "usage-delta", usage, messageId: state.messageId };
    return { kind: "ignore" };
  }
  if (typeof e.text === "string" && e.type === "text_delta") {
    if (e.text) state.producedContent = true;
    return { kind: "text", text: e.text };
  }
  return { kind: "ignore" };
}

function expectedParallelGroup(names: string[]): number {
  const { PARALLEL_SAFE_TOOLS } = { PARALLEL_SAFE_TOOLS: new Set(["read", "glob", "grep", "list", "task", "subagent"]) };
  let run = 0;
  for (const name of names) {
    if (!PARALLEL_SAFE_TOOLS.has(name)) break;
    run += 1;
  }
  return Math.max(1, run);
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
    return;
  }
  let body: ChatBody;
  try {
    body = parseChatBody(JSON.parse(raw));
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
    return;
  }

  const authRefusal = await checkSubscriptionAuth();
  if (authRefusal) {
    sendError(res, 401, authRefusal);
    return;
  }

  const messages = body.messages;
  const requestedModel = body.model;
  const strippedModel = requestedModel.replace(/^claude-code\//, "");
  const fastMode = isFastModelId(strippedModel);
  const model = resolveClaudeModelId(strippedModel);
  const stream = body.stream;
  const metaKind = detectMetaRequestKind(messages);
  const key = metaKind ? `meta:${randomUUID()}` : conversationKey(messages, model);
  const configDir = process.env.CLAUDE_CONFIG_DIR || undefined;

  debugLog("request", {
    model,
    stream,
    messages: messages.length,
    tools: body.tools.length,
    meta: metaKind,
  });
  const toolResults = metaKind ? new Map<string, McpToolResultContent[]>() : collectToolResults(messages);
  if (!metaKind) attachPromotedToolMedia(messages, toolResults);

  // Resume parked bridge
  let existing = metaKind ? undefined : findBridgeByConversation(key);
  if (!metaKind && (!existing || existing.pendingTools.size === 0) && toolResults.size > 0) {
    for (const toolCallId of toolResults.keys()) {
      const byTool = findBridgeByPendingTool(toolCallId);
      if (byTool) {
        existing = byTool;
        break;
      }
    }
  }
  if (existing && existing.pendingTools.size > 0) {
    const match = matchTurnHistory(getSessionTurns(existing.conversationKey), userHistoryFingerprints(messages));
    if (match.kind === "diverged" || match.kind === "rewind") {
      await stopConversationBridges(existing.conversationKey, "History replaced");
      existing = undefined;
    }
  }
  if (existing && existing.pendingTools.size > 0) {
    let resolved = 0;
    for (const [toolId, tool] of existing.pendingTools) {
      const result = toolResults.get(toolId);
      if (result !== undefined) {
        tool.resolve(result);
        existing.pendingTools.delete(toolId);
        resolved++;
      }
    }
    if (existing.pendingTools.size === 0 && existing.continueStream) {
      if (stream) {
        await streamTurnResponse(existing.continueStream(), requestedModel, existing, res);
      } else {
        await collectTurnResponse(existing.continueStream(), requestedModel, existing, res);
      }
      return;
    }
    if (existing.pendingTools.size > 0) {
      const parkedEvents = (async function* () {
        yield { type: "__park__", tools: [...existing!.pendingTools.values()] };
      })();
      if (stream) {
        await streamTurnResponse(parkedEvents, requestedModel, existing, res);
      } else {
        await collectTurnResponse(parkedEvents, requestedModel, existing, res);
      }
      return;
    }
    void resolved;
  }

  const releaseSpawnLock = await acquireSpawnLock(key);
  try {
    await startNewTurn({ body, messages, key, model, requestedModel, stream, fastMode, toolResults, configDir, metaKind, res });
  } finally {
    releaseSpawnLock();
  }
}

async function startNewTurn(input: {
  body: ChatBody;
  messages: ZedMessage[];
  key: string;
  model: string;
  requestedModel: string;
  stream: boolean;
  fastMode: boolean;
  toolResults: Map<string, McpToolResultContent[]>;
  configDir?: string;
  metaKind: MetaRequestKind;
  res: ServerResponse;
}): Promise<void> {
  const { body, messages, key, model, requestedModel, stream, fastMode, configDir, metaKind, res } = input;
  const isMeta = metaKind !== null;
  const existing = findBridgeByConversation(key);
  if (existing) {
    await stopConversationBridges(key, "Superseded by a newer turn");
  }

  const env = buildClaudeCodeChildEnv();
  const cwd = cwdFromEnv();
  const bridgeId = randomUUID();
  const pendingTools = new Map<string, ParkedToolCall>();
  let handle: StoppableClaudeQueryHandle | null = null;
  let parked = false;
  let parkWaiters: Array<() => void> = [];
  let messageOpen = false;
  let pendingNext: Promise<IteratorResult<unknown>> | null = null;
  let messageToolNames: string[] = [];

  const trackMessageState = (event: unknown) => {
    if (!event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    if (e.type === "stream_event" && e.event && typeof e.event === "object") {
      const ev = e.event as { type?: unknown; content_block?: { type?: unknown; name?: unknown } };
      if (ev.type === "message_start") {
        messageOpen = true;
        messageToolNames = [];
      }
      if (ev.type === "message_stop") messageOpen = false;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use" && typeof ev.content_block.name === "string") {
        messageToolNames.push(openZedToolName(ev.content_block.name));
      }
    }
  };

  const notifyPark = () => {
    parked = true;
    debugLog("park", { pending: pendingTools.size });
    const waiters = parkWaiters;
    parkWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const openCodeTools = isMeta || body.tool_choice === "none" ? [] : body.tools;
  const answeredStep = isMeta ? null : answeredToolStepIndex(messages);
  let prompt: string | SdkUserPrompt = isMeta
    ? buildMetaPrompt(metaKind!, messages)
    : answeredStep !== null
      ? answeredToolStepPrompt(messages, answeredStep)
      : latestUserPrompt(messages);
  const priorMessages = answeredStep !== null ? messages.slice(0, answeredStep) : priorMessagesOf(messages);
  const promptEmpty = typeof prompt === "string" ? prompt.length === 0 : false;
  if (promptEmpty && openCodeTools.length === 0) {
    sendError(res, 400, "No user message found");
    return;
  }

  const prints = userHistoryFingerprints(messages);
  const before = userHistoryFingerprints(priorMessages);
  let resume: string | undefined;
  if (!isMeta) {
    const sessionId = getForeignSessionId(key);
    const probeFor = (id: string): SessionFileProbe | null => {
      const file = findClaudeSessionFile(id, configDir);
      if (!file) return null;
      return {
        exists: true,
        hasEntry: (uuid) => sessionFileHasEntry(file, uuid),
        chainAfterLeaf: (uuid) => sessionChainAfterLeaf(file, uuid),
        lastEntry: () => lastChainEntryUuid(file),
      };
    };
    const plan = planResume({
      turns: getSessionTurns(key),
      prints: before,
      priorMessages,
      sessionId,
      leafUuid: getSessionLeafUuid(key),
      probeFor,
    });
    resume = plan.resume;
    debugLog("resume", {
      reason: plan.reason,
      resume: Boolean(plan.resume),
      fork: Boolean(plan.forkAt),
      rewind: plan.rewindIndex,
    });
    let missedMessages: ZedMessage[] = plan.missedMessages;
    let transcriptMode = plan.transcript;
    if (plan.clearBinding) clearForeignSessionId(key);
    if (plan.rewindIndex !== undefined) rewindSessionTurns(key, plan.rewindIndex);
    if (plan.forkAt) {
      try {
        const forked = await getClaudeSessionForker()(plan.forkAt.sessionId, plan.forkAt.leafUuid);
        const forkedFile = findClaudeSessionFile(forked, configDir);
        if (!forkedFile) throw new Error("Forked session transcript not found");
        setForeignSessionId(key, forked, {
          modelId: model,
          cwd,
          leafUuid: lastChainEntryUuid(forkedFile),
        });
        resume = forked;
      } catch {
        clearForeignSessionId(key);
        resume = undefined;
        missedMessages = priorMessages;
        transcriptMode = "history";
      }
    }
    const transcript =
      transcriptMode === "history"
        ? buildConversationTranscript(priorMessages)
        : transcriptMode === "missed"
          ? buildConversationTranscript(missedMessages)
          : "";
    const withContext = withConversationContext(prompt, transcript, Boolean(resume));
    prompt = typeof withContext === "string" ? withContext || " " : withContext;
  }
  const claudePrompt: string | SdkUserPrompt = typeof prompt === "string" ? prompt || " " : prompt;

  const mcpServers =
    openCodeTools.length > 0 ? await buildZedMcpServer(openCodeTools, pendingTools, notifyPark) : undefined;
  if (openCodeTools.length > 0 && !mcpServers) {
    sendError(res, 503, "Claude Code could not load Zed tools for this turn. Retry.");
    return;
  }
  const toolNames = openCodeTools.map((t) => t.function?.name).filter((n): n is string => typeof n === "string" && n.length > 0);
  const toolAliases = openCodeTools.length > 0 ? buildToolAliases(toolNames) : undefined;

  const bridge: ParkedBridge = {
    id: bridgeId,
    conversationKey: key,
    handle: null as unknown as StoppableClaudeQueryHandle,
    pendingTools,
    reportedUsage: new Map(),
    forwardedSteering: new Set(),
    createdAt: Date.now(),
    configDir,
  };

  try {
    handle = withGracefulStop(
      await getClaudeQueryStarter()({
        prompt:
          isMeta && typeof claudePrompt === "string"
            ? promptAsStream(claudePrompt, true)
            : typeof claudePrompt === "string"
              ? claudePrompt
              : promptAsStream(claudePrompt),
        cwd,
        model,
        resume: isMeta ? undefined : resume,
        env,
        mcpServers: isMeta ? undefined : mcpServers,
        autoCompactEnabled: !isMeta,
        isolateMcp: true,
        settingSources: isMeta ? [] : ["project"],
        effort: isMeta ? undefined : body.reasoning_effort,
        fastMode: fastMode || undefined,
        outputFormat: isMeta ? undefined : body.outputFormat,
        skills: isMeta ? [] : undefined,
        persistSession: isMeta ? false : undefined,
        maxTurns: isMeta ? 1 : undefined,
        thinking: isMeta ? { type: "disabled" } : undefined,
        tools: [],
        toolAliases,
        allowedTools: openCodeTools.length > 0 ? toolNames.map((n) => `mcp__zed__${n}`) : undefined,
        permissionMode: "dontAsk",
        systemPrompt: isMeta
          ? UTILITY_SYSTEM_PROMPT
          : {
              type: "preset",
              preset: "claude_code",
              excludeDynamicSections: true,
              append:
                "Built-in Claude Code tools are disabled. Use only the mcp__zed__* tools provided for this turn." +
                (openCodeTools.length === 0
                  ? ""
                  : body.parallel_tool_calls === false
                    ? " Make at most one tool call at a time: wait for each result before deciding on the next call."
                    : " Batch independent tool calls into a single turn."),
            },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = classifyClaudeFailure(message);
    const status = (error as { statusCode?: number }).statusCode ?? failureStatusFor(kind);
    debugLog("error", { kind, status });
    sendError(res, status, message);
    return;
  }
  if (!isMeta && prints.length > 0) {
    recordTurnStart(key, { count: prints.length, hash: prints.at(-1)! }, before.length > 0 ? { count: before.length, hash: before.at(-1)! } : undefined);
  }
  bridge.handle = handle;
  if (!isMeta) {
    handle.onEvent((event) => {
      const e = event as Record<string, unknown>;
      const sessionId = typeof e.session_id === "string" ? e.session_id : null;
      if (sessionId) {
        setForeignSessionId(key, sessionId, {
          modelId: model,
          cwd,
          leafUuid: typeof e.uuid === "string" ? e.uuid : undefined,
        });
      }
    });
  }
  putBridge(bridge);

  let reapTimer: ReturnType<typeof setTimeout> | null = null;
  const armReap = () => {
    if (reapTimer) clearTimeout(reapTimer);
    const ms = parkedTurnTtlMs();
    if (ms === null) return;
    reapTimer = setTimeout(() => {
      reapTimer = null;
      if (!parked) return;
      void stopBridge(bridgeId);
    }, ms);
    reapTimer.unref?.();
  };

  async function* consumeStream(): AsyncGenerator<unknown, void, unknown> {
    const iterator = handle!.stream[Symbol.asyncIterator]();
    let handedOff = false;
    let settled = false;
    try {
      while (true) {
        const holding = parked && pendingTools.size > 0;
        if (holding && !messageOpen && (settled || pendingTools.size >= expectedParallelGroup(messageToolNames))) {
          settled = false;
          armReap();
          handedOff = true;
          yield { type: "__park__", tools: [...pendingTools.values()] };
          return;
        }
        const parkControl = { cancel: null as (() => void) | null };
        const parkPromise = new Promise<void>((resolve) => {
          const entry = () => resolve();
          parkWaiters.push(entry);
          parkControl.cancel = () => {
            parkWaiters = parkWaiters.filter((w) => w !== entry);
          };
        });
        let quietTimer: ReturnType<typeof setTimeout> | null = null;
        const quietPromise = new Promise<void>((resolve) => {
          if (!holding) return;
          quietTimer = setTimeout(resolve, messageOpen ? PARK_QUIET_MS : PARK_SETTLE_MS);
          quietTimer.unref?.();
        });
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const stallPromise = new Promise<never>((_, reject) => {
          const ms = turnStallMs();
          stallTimer = setTimeout(() => {
            reject(new Error(`Claude Code produced no output for ${Math.round(ms / 1000)}s — the turn was killed. Retry the message.`));
          }, ms);
          stallTimer.unref?.();
        });
        const nextPromise = pendingNext ?? iterator.next();
        pendingNext = null;
        let raced: { kind: string; value?: IteratorResult<unknown> };
        try {
          raced = await Promise.race([
            nextPromise.then((value) => ({ kind: "event", value })),
            parkPromise.then(() => ({ kind: "park" })),
            quietPromise.then(() => ({ kind: "quiet" })),
            stallPromise,
          ]);
        } catch (error) {
          nextPromise.then(
            () => {},
            () => {},
          );
          throw error;
        } finally {
          if (stallTimer) clearTimeout(stallTimer);
          if (quietTimer) clearTimeout(quietTimer);
        }
        parkControl.cancel?.();
        if (raced.kind === "park") {
          pendingNext = nextPromise;
          continue;
        }
        if (raced.kind === "quiet") {
          pendingNext = nextPromise;
          if (!messageOpen) settled = true;
          messageOpen = false;
          continue;
        }
        if (raced.value!.done) break;
        const event = raced.value!.value;
        trackMessageState(event);
        yield event;
      }
    } finally {
      if (!handedOff) {
        deleteBridge(bridgeId);
      }
    }
  }

  bridge.continueStream = async function* () {
    if (reapTimer) clearTimeout(reapTimer);
    parked = false;
    parkWaiters = [];
    yield* consumeStream();
  };

  if (stream) {
    const probe = await probeTurn(consumeStream());
    if (probe.status === "failed") {
      const kind = classifyClaudeFailure(probe.errorText);
      const status = failureStatusFor(kind);
      debugLog("error", { kind, status, phase: "probe" });
      sendError(res, status, probe.errorText);
      return;
    }
    await streamTurnResponse(probe.replay, requestedModel, bridge, res);
  } else {
    await collectTurnResponse(consumeStream(), requestedModel, bridge, res);
  }

  async function* chainBuffered(buffered: unknown[], iterator: AsyncIterator<unknown>): AsyncGenerator<unknown> {
    yield* buffered;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      yield next.value;
    }
  }

  async function probeTurn(events: AsyncIterable<unknown>): Promise<{ status: "alive"; replay: AsyncGenerator<unknown> } | { status: "failed"; errorText: string }> {
    const iterator = events[Symbol.asyncIterator]();
    const buffered: unknown[] = [];
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const raw = next.value as Record<string, unknown> | null;
        const kind = rawProbeKind(next.value);
        if (kind === "error") return { status: "failed", errorText: rawErrorText(next.value) };
        buffered.push(next.value);
        if (kind === "content") return { status: "alive", replay: chainBuffered(buffered, iterator) };
      }
    } catch (err) {
      return { status: "failed", errorText: err instanceof Error ? err.message : "Claude turn failed" };
    }
    return { status: "failed", errorText: "Claude Code ended the turn without any output" };
  }

  function rawProbeKind(value: unknown): "content" | "error" | "other" {
    if (!value || typeof value !== "object") return "other";
    const e = value as Record<string, unknown>;
    if (e.type === "__park__") return "content";
    if (e.type === "result" && e.is_error) return "error";
    if (e.type === "stream_event" && e.event && typeof e.event === "object") {
      const ev = e.event as { type?: string };
      if (ev.type === "content_block_delta" || ev.type === "content_block_start") return "content";
    }
    if (e.type === "assistant" || e.type === "text_delta") return "content";
    return "other";
  }

  function rawErrorText(value: unknown): string {
    const e = value as Record<string, unknown>;
    if (typeof e.error === "string") return e.error;
    return "Claude turn failed";
  }
}

async function relayStreamToResponse(
  events: AsyncIterable<unknown>,
  model: string,
  bridge: ParkedBridge,
  res: ServerResponse,
): Promise<void> {
  const id = `chatcmpl_${createHash("sha1").update(bridge.id).digest("hex").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit = (data: string): boolean => res.write(`data: ${data}\n\n`);
  emit(JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
  let finishReason: string | null = "stop";
  let finishLocked = false;
  const mapState: MapState = { messageId: null };
  const tracker = new TurnUsageTracker(bridge.reportedUsage);
  let resultUsage: OpenAIUsage | null = null;
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 5_000);
  heartbeat.unref?.();
  let responseDone = false;
  res.on("close", () => {
    if (responseDone || bridge.pendingTools.size > 0) return;
    void stopBridge(bridge.id, "Client disconnected before the turn finished");
  });
  try {
    for await (const event of events) {
      const mapped = mapSdkEvent(event, mapState);
      if (mapped.kind === "park") {
        finishReason = "tool_calls";
        finishLocked = true;
        mapped.tools.forEach((tool, i) => {
          emit(
            JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tool.id, type: "function", function: { name: openZedToolName(tool.name), arguments: tool.arguments } }] }, finish_reason: null }],
            }),
          );
        });
        break;
      }
      if (mapped.kind === "text" && mapped.text) {
        emit(JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: mapped.text }, finish_reason: null }] }));
      }
      if (mapped.kind === "reasoning" && mapped.text) {
        emit(JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: mapped.text }, finish_reason: null }] }));
      }
      if (mapped.kind === "usage-delta") {
        tracker.add(mapped.usage, mapped.messageId);
      }
      if (mapped.kind === "usage") {
        resultUsage = mapped.usage;
      }
      if (mapped.kind === "retry") {
        const label = mapped.status ?? "connection";
        res.write(`: retry ${label} attempt ${mapped.attempt}/${mapped.maxRetries} in ${Math.round(mapped.delayMs / 1000)}s\n\n`);
      }
      if (mapped.kind === "error") {
        emit(JSON.stringify({ error: { message: mapped.text, type: "claude_error" } }));
        finishReason = finishReasonFor(mapState.stopReason);
        finishLocked = true;
      }
    }
    if (!finishLocked) finishReason = finishReasonFor(mapState.stopReason);
    const usage = resolveTurnUsage(tracker.total(), resultUsage);
    if (usage) debugLog("usage", { ...usage });
    emit(
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      }),
    );
  } finally {
    clearInterval(heartbeat);
  }
  responseDone = true;
  res.end("data: [DONE]\n\n");
}

async function streamTurnResponse(events: AsyncIterable<unknown>, model: string, bridge: ParkedBridge, res: ServerResponse): Promise<void> {
  await relayStreamToResponse(events, model, bridge, res);
}

async function collectTurnResponse(events: AsyncIterable<unknown>, model: string, bridge: ParkedBridge, res: ServerResponse): Promise<void> {
  const id = `chatcmpl_${createHash("sha1").update(bridge.id).digest("hex").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let responseDone = false;
  res.on("close", () => {
    if (responseDone || bridge.pendingTools.size > 0) return;
    void stopBridge(bridge.id, "Client disconnected before the turn finished");
  });
  let content = "";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const tracker = new TurnUsageTracker(bridge.reportedUsage);
  let resultUsage: OpenAIUsage | null = null;
  const mapState: MapState = { messageId: null };
  let errorText: string | null = null;
  let structuredOutput: unknown;
  for await (const event of events) {
    const mapped = mapSdkEvent(event, mapState);
    if (mapped.kind === "park") {
      for (const t of mapped.tools) {
        toolCalls.push({ id: t.id, type: "function", function: { name: openZedToolName(t.name), arguments: t.arguments } });
      }
    } else if (mapped.kind === "text") {
      content += mapped.text;
    } else if (mapped.kind === "usage-delta") {
      tracker.add(mapped.usage, mapped.messageId);
    } else if (mapped.kind === "usage") {
      resultUsage = mapped.usage;
      if (mapped.structured !== undefined) structuredOutput = mapped.structured;
    } else if (mapped.kind === "error") {
      errorText = mapped.text;
    }
  }
  if (errorText && toolCalls.length === 0 && !content) {
    const kind = classifyClaudeFailure(errorText);
    const status = failureStatusFor(kind);
    debugLog("error", { kind, status, phase: "collect" });
    sendError(res, status, errorText);
    return;
  }
  if (!content && toolCalls.length === 0 && structuredOutput !== undefined) {
    content = JSON.stringify(structuredOutput, null, 2);
  }
  const usage = resolveTurnUsage(tracker.total(), resultUsage) ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  debugLog("usage", { ...usage });
  res.writeHead(200, { "Content-Type": "application/json" });
  responseDone = true;
  res.end(openAICompletion(id, created, model, content, toolCalls, usage, mapState.stopReason));
}

export function startServer(port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      void handleHealth(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      void handleModels(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      void handleChat(req, res).catch((error) => {
        if (!res.headersSent) sendError(res, 500, error instanceof Error ? error.message : String(error));
        else res.end();
      });
      return;
    }
    sendError(res, 404, `Unknown endpoint: ${url.pathname}`);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`claude-zed-shim listening on http://127.0.0.1:${port}`);
    console.log(`Health: http://127.0.0.1:${port}/health`);
  });
  return server;
}

process.on("SIGINT", () => {
  void clearAllBridges().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void clearAllBridges().finally(() => process.exit(0));
});
