import { createHash } from "node:crypto";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } };

export type SdkUserPrompt = {
  type: "user";
  message: { role: "user"; content: string | AnthropicContentBlock[] };
  parent_tool_use_id: null;
};

export type McpToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return { mediaType: (match[1] || "application/octet-stream").toLowerCase(), data: match[2] ?? "" };
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function mediaLooksLikePdf(mediaType: string, urlHint = ""): boolean {
  return (
    mediaType.includes("pdf") ||
    /\.pdf(\?|#|$)/i.test(urlHint) ||
    (mediaType === "application/octet-stream" && /\.pdf(\?|#|$)/i.test(urlHint))
  );
}

function mediaLooksLikeImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function pushText(blocks: AnthropicContentBlock[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text = `${last.text}\n${trimmed}`;
    return;
  }
  blocks.push({ type: "text", text: trimmed });
}

function pushDataUrl(blocks: AnthropicContentBlock[], url: string): boolean {
  const parsed = parseDataUrl(url);
  if (!parsed) return false;
  if (mediaLooksLikeImage(parsed.mediaType)) {
    blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
    return true;
  }
  if (mediaLooksLikePdf(parsed.mediaType)) {
    blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: parsed.data } });
    return true;
  }
  blocks.push({ type: "document", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
  return true;
}

function pushRemoteUrl(blocks: AnthropicContentBlock[], url: string, mediaTypeHint?: string): void {
  const mediaType = (mediaTypeHint || "").toLowerCase();
  if (mediaLooksLikePdf(mediaType, url)) {
    blocks.push({ type: "document", source: { type: "url", url } });
    return;
  }
  blocks.push({ type: "image", source: { type: "url", url } });
}

function convertPart(part: unknown, blocks: AnthropicContentBlock[]): void {
  if (!part || typeof part !== "object") return;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";
  if (type === "text" && typeof p.text === "string") {
    pushText(blocks, p.text);
    return;
  }
  if (type === "image_url") {
    const imageUrl = p.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl && typeof imageUrl === "object" && typeof (imageUrl as { url?: unknown }).url === "string"
          ? (imageUrl as { url: string }).url
          : null;
    if (!url) return;
    if (pushDataUrl(blocks, url)) return;
    if (isHttpUrl(url)) pushRemoteUrl(blocks, url);
    return;
  }
  if (type === "image" || type === "input_image") {
    const image = (p as { image?: unknown }).image;
    if (typeof image === "string") {
      if (pushDataUrl(blocks, image)) return;
      if (isHttpUrl(image)) pushRemoteUrl(blocks, image);
      return;
    }
  }
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function contentHasAttachments(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return type === "image_url" || type === "input_image" || type === "file" || type === "input_file" || type === "image" || type === "document";
  });
}

export function openaiContentToAnthropicBlocks(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) convertPart(part, blocks);
  return blocks;
}

export function userMessagePrompt(content: unknown): string | AnthropicContentBlock[] {
  const blocks = openaiContentToAnthropicBlocks(content);
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]?.type === "text") return blocks[0].text;
  return blocks;
}

type HistoryMessage = { role?: string; content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>; tool_call_id?: string; name?: string };

function latestUserTurn(messages: HistoryMessage[]): number[] {
  const out: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      out.unshift(i);
      const prev = messages[i - 1];
      if (prev?.role === "user") continue;
      break;
    }
    if (out.length > 0) break;
  }
  if (out.length === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        out.unshift(i);
        break;
      }
    }
  }
  return out;
}

export function latestUserPrompt(messages: HistoryMessage[]): string | SdkUserPrompt {
  const parts = latestUserTurn(messages)
    .map((i) => userMessagePrompt(messages[i]!.content))
    .filter((part) => part.length > 0);
  if (parts.every((part) => typeof part === "string")) {
    return parts.join("\n\n");
  }
  return {
    type: "user",
    message: {
      role: "user",
      content: parts.flatMap((part) => (typeof part === "string" ? [{ type: "text" as const, text: part }] : part)),
    },
    parent_tool_use_id: null,
  };
}

const TOOL_RESULT_MAX_CHARS = 20_000;
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return `${text.slice(0, head)}\n... [truncated ${text.length - max} chars] ...\n${text.slice(text.length - tail)}`;
}

function serializeHistoryMessage(msg: HistoryMessage, toolNames: Map<string, string>): string | null {
  const role = msg?.role;
  if (role === "system") {
    const text = extractTextContent(msg.content).trim();
    return text ? `System:\n${text}` : null;
  }
  if (role === "user") {
    const text = extractTextContent(msg.content).trim();
    return text ? `User:\n${truncateMiddle(text, TOOL_RESULT_MAX_CHARS)}` : null;
  }
  if (role === "assistant") {
    const parts: string[] = [];
    const text = extractTextContent(msg.content).trim();
    if (text) parts.push(text);
    for (const call of msg?.tool_calls ?? []) {
      if (call?.function?.name) parts.push(`Tool call (${call.function.name}): ${call.function.arguments ?? "{}"}`);
    }
    return parts.length ? `Assistant:\n${truncateMiddle(parts.join("\n"), TOOL_RESULT_MAX_CHARS)}` : null;
  }
  if (role === "tool") {
    const text = extractTextContent(msg.content).trim() || JSON.stringify(msg.content ?? "");
    const label =
      (typeof msg.name === "string" && msg.name) ||
      (typeof msg.tool_call_id === "string" && (toolNames.get(msg.tool_call_id) || msg.tool_call_id)) ||
      "tool";
    return text ? `Tool result (${label}):\n${truncateMiddle(text, TOOL_RESULT_MAX_CHARS)}` : null;
  }
  return null;
}

export function priorMessagesOf(messages: HistoryMessage[]): HistoryMessage[] {
  const start = latestUserTurn(messages)[0] ?? 0;
  const answeredAfter = messages.slice(start + 1).some((m) => m?.role === "assistant" || m?.role === "tool");
  return answeredAfter ? messages.slice() : messages.slice(0, start);
}

export function buildConversationTranscript(messages: HistoryMessage[], maxChars = 400_000): string {
  if (maxChars <= 0) return "";
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    for (const call of msg?.tool_calls ?? []) {
      if (call?.id && call.function?.name) toolNames.set(call.id, call.function.name);
    }
  }
  const serialized: string[] = [];
  for (const msg of messages) {
    const line = serializeHistoryMessage(msg, toolNames);
    if (line) serialized.push(line);
  }
  if (serialized.length === 0) return "";
  const kept: string[] = [];
  let total = 0;
  let omitted = 0;
  for (let i = serialized.length - 1; i >= 0; i--) {
    const entry = serialized[i]!;
    if (total + entry.length > maxChars) {
      omitted = i + 1;
      break;
    }
    kept.unshift(entry);
    total += entry.length;
  }
  const header = omitted > 0 ? `[${omitted} earlier message(s) omitted]\n\n` : "";
  return header + kept.join("\n\n");
}

export function withConversationContext(
  prompt: string | SdkUserPrompt,
  transcript: string,
  missed = false,
): string | SdkUserPrompt {
  const body = transcript.trim();
  if (!body) return prompt;
  const intro = missed
    ? "These messages were added to this chat after your last turn, without you. Treat them as part of the conversation — do not re-do completed work — and respond to the user's latest message, which follows them.\n\n"
    : "The earlier conversation of this chat is included below because the previous Claude session could not be resumed. Treat it as established context — do not re-do completed work — and respond to the user's latest message, which follows the history.\n\n";
  const prefix = "<conversation_history>\n" + intro + body + "\n</conversation_history>\n\nLatest user message:\n";
  if (typeof prompt === "string") return prefix + prompt;
  const content = Array.isArray(prompt.message.content) ? prompt.message.content : [];
  return { ...prompt, message: { role: "user", content: [{ type: "text", text: prefix }, ...content] } };
}

export function withLeadingText(prompt: string | SdkUserPrompt, text: string): string | SdkUserPrompt {
  if (!text) return prompt;
  if (typeof prompt === "string") return `${text}\n\n${prompt}`;
  const content = Array.isArray(prompt.message.content) ? prompt.message.content : [{ type: "text" as const, text: prompt.message.content }];
  return { ...prompt, message: { role: "user", content: [{ type: "text", text }, ...content] } };
}

const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function fingerprintedUserMessages(messages: HistoryMessage[]): Array<{ index: number; print: string }> {
  const entries: Array<{ index: number; print: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const text = extractTextContent(msg.content).replace(SYSTEM_REMINDER_BLOCK, " ").replace(/\s+/g, " ").trim();
    const identity = text || (contentHasAttachments(msg.content) ? "\u0000attachments" : "");
    if (!identity) continue;
    entries.push({ index: i, print: createHash("sha1").update(identity).digest("hex").slice(0, 16) });
  }
  return entries;
}

export function userHistoryFingerprints(messages: HistoryMessage[]): string[] {
  return fingerprintedUserMessages(messages).map((entry) => entry.print);
}

export function historyAfterUserCount<T extends HistoryMessage>(messages: T[], count: number): T[] {
  const next = fingerprintedUserMessages(messages)[count];
  return next ? messages.slice(next.index) : [];
}

export function openaiToolResultToMcpContent(content: unknown): McpToolResultContent[] {
  const result: McpToolResultContent[] = [];
  for (const block of openaiContentToAnthropicBlocks(content)) {
    if (block.type === "text") {
      result.push(block);
      continue;
    }
    if (block.source.type === "url") {
      result.push({ type: "text", text: `Media URL (not downloadable in tool result): ${block.source.url}` });
      continue;
    }
    if (block.type === "image") {
      result.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
    } else {
      result.push({
        type: "resource",
        resource: { uri: `doc.${block.source.media_type === "application/pdf" ? "pdf" : "bin"}`, mimeType: block.source.media_type, blob: block.source.data },
      });
    }
  }
  return result;
}

export function decodeToolMessageContent(content: unknown): unknown {
  return content;
}

// --- OpenAI chunk builders (Zed-compatible shapes) ---

let completionCounter = 0;
export function newCompletionId(): string {
  completionCounter += 1;
  return `chatcmpl-zed-claude-${Date.now().toString(36)}-${completionCounter}`;
}

export function openAIStreamChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

export function openAICompletion(
  id: string,
  created: number,
  model: string,
  content: string,
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): string {
  return JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage,
  });
}

export function openAIError(status: number, message: string, code = "claude_error"): { status: number; body: string } {
  return {
    status,
    body: JSON.stringify({ error: { message, type: code, code: String(status) } }),
  };
}

export type ClaudeFailureKind = "auth" | "rate_limit" | "context_overflow" | "image" | "refusal" | "overloaded" | "billing" | "unknown";

const AUTH_FAILURE_PATTERN =
  /invalid_grant|refresh token (not found|invalid|expired)|invalid[_ -]?api[_ -]?key|authentication_error|authentication failed|unauthorized|not logged in|not authenticated|please (run )?\/?login|oauth token (is )?(expired|invalid|revoked)|access token (is )?(expired|invalid|revoked)|credentials (are )?(expired|invalid|revoked)|token (has )?expired|\b401\b/i;
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|exceeds the context window|context[_ ]length[_ ]exceeded|exceeds (?:the )?(?:model'?s )?maximum context length|input is too long for requested model|model_context_window_exceeded/i;
const BILLING_FAILURE_PATTERN =
  /draw from extra usage|extra usage (?:is )?(?:not enabled|disabled|required|exhausted|limit)|out of extra usage|credit balance is too low/i;
const IMAGE_FAILURE_PATTERN =
  /could not process image|\bimage\b[^\n]*?\b(?:exceeds?|too large|could not be processed|is not valid|invalid|unsupported|not supported|dimensions)\b/i;
const OVERLOADED_PATTERN = /^Anthropic (?:is overloaded|returned 5\d\d)\b/i;

export function classifyClaudeFailure(text: string): ClaudeFailureKind {
  if (!text) return "unknown";
  if (/^Claude declined this request\b/.test(text)) return "refusal";
  if (OVERLOADED_PATTERN.test(text)) return "overloaded";
  if (/\brate limit\b|rate_limit|429|usage limit|limit reached|reset/i.test(text)) return "rate_limit";
  if (AUTH_FAILURE_PATTERN.test(text)) return "auth";
  if (BILLING_FAILURE_PATTERN.test(text)) return "billing";
  if (CONTEXT_OVERFLOW_PATTERN.test(text)) return "context_overflow";
  if (IMAGE_FAILURE_PATTERN.test(text)) return "image";
  return "unknown";
}

export function failureStatusFor(kind: ClaudeFailureKind): number {
  switch (kind) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "context_overflow":
    case "image":
    case "refusal":
      return 400;
    case "overloaded":
      return 503;
    case "billing":
      return 402;
    case "unknown":
      return 500;
  }
}

export function usageFromSdkResult(event: unknown): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} | null {
  const e = event as { usage?: unknown };
  if (!e?.usage || typeof e.usage !== "object") return null;
  return usageFromAnthropic(e.usage as Record<string, unknown>);
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFromAnthropic(usage: Record<string, unknown>): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const input = asNumber(usage.input_tokens);
  const completion = asNumber(usage.output_tokens);
  const cached = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  const prompt = input + cached + cacheWrite;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
