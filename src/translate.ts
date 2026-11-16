import { createHash } from "node:crypto";
import type { OpenAIUsage } from "./usage.ts";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } };

export type SdkUserPrompt = {
  type: "user";
  message: { role: "user"; content: string | AnthropicContentBlock[] };
  parent_tool_use_id: null;
};

export async function* promptAsStream(
  prompt: string | SdkUserPrompt,
): AsyncGenerator<SdkUserPrompt, void, unknown> {
  if (typeof prompt === "string") {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    };
    return;
  }
  yield prompt;
}

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
  if (type === "image") {
    const mediaType =
      typeof p.media_type === "string"
        ? p.media_type
        : typeof p.mimeType === "string"
          ? p.mimeType
          : typeof p.mime === "string"
            ? p.mime
            : "image/png";
    const source = p.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (s.type === "base64" && typeof s.data === "string") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: typeof s.media_type === "string" ? s.media_type : mediaType,
            data: s.data,
          },
        });
        return;
      }
      if (s.type === "url" && typeof s.url === "string") {
        if (pushDataUrl(blocks, s.url)) return;
        if (isHttpUrl(s.url)) pushRemoteUrl(blocks, s.url, mediaType);
        return;
      }
    }
    const image = p.image;
    if (typeof image === "string") {
      if (pushDataUrl(blocks, image)) return;
      if (isHttpUrl(image)) {
        pushRemoteUrl(blocks, image, mediaType);
        return;
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: image },
      });
      return;
    }
    if (image instanceof URL) {
      const href = image.toString();
      if (pushDataUrl(blocks, href)) return;
      if (isHttpUrl(href)) pushRemoteUrl(blocks, href, mediaType);
      return;
    }
    if (image && typeof image === "object" && "url" in image) {
      const url = (image as { url?: unknown }).url;
      if (typeof url === "string") {
        if (pushDataUrl(blocks, url)) return;
        if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType);
      }
    }
    return;
  }
  if (type === "document") {
    const mediaType =
      typeof p.media_type === "string"
        ? p.media_type
        : typeof p.mimeType === "string"
          ? p.mimeType
          : "application/pdf";
    const source = p.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (s.type === "base64" && typeof s.data === "string") {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: typeof s.media_type === "string" ? s.media_type : mediaType,
            data: s.data,
          },
        });
        return;
      }
      if (s.type === "url" && typeof s.url === "string") {
        if (pushDataUrl(blocks, s.url)) return;
        if (isHttpUrl(s.url)) pushRemoteUrl(blocks, s.url, mediaType);
        return;
      }
    }
    const data = typeof p.data === "string" ? p.data : null;
    if (data) {
      if (/^data:/i.test(data)) {
        pushDataUrl(blocks, data);
        return;
      }
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: mediaLooksLikePdf(mediaType) ? "application/pdf" : mediaType,
          data,
        },
      });
    }
    return;
  }
  if (type === "input_image") {
    const url = typeof p.image_url === "string" ? p.image_url : null;
    const b64 = typeof p.data === "string" ? p.data : null;
    const mediaType = typeof p.media_type === "string" ? p.media_type : "image/png";
    if (url) {
      if (pushDataUrl(blocks, url)) return;
      if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType);
      return;
    }
    if (b64) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: b64 },
      });
    }
    return;
  }
  if (type === "file" || type === "input_file") {
    const file = (p.file && typeof p.file === "object" ? p.file : p) as Record<string, unknown>;
    const fileData = typeof file.file_data === "string" ? file.file_data : null;
    const url =
      typeof file.url === "string"
        ? file.url
        : typeof file.uri === "string"
          ? file.uri
          : fileData && /^data:/i.test(fileData)
            ? fileData
            : null;
    const data =
      typeof file.data === "string"
        ? file.data
        : fileData && !/^data:/i.test(fileData)
          ? fileData
          : null;
    const name =
      typeof file.filename === "string"
        ? file.filename
        : typeof p.filename === "string"
          ? p.filename
          : "";
    const mediaType =
      typeof file.media_type === "string"
        ? file.media_type
        : typeof file.mime_type === "string"
          ? file.mime_type
          : typeof file.mime === "string"
            ? file.mime
            : mediaLooksLikePdf("", name)
              ? "application/pdf"
              : "application/octet-stream";

    if (url) {
      if (pushDataUrl(blocks, url)) return;
      if (isHttpUrl(url)) {
        pushRemoteUrl(blocks, url, mediaType);
        return;
      }
      pushText(blocks, `[Attachment ${name || url} could not be relayed inline]`);
      return;
    }
    if (data) {
      if (/^data:/i.test(data)) {
        pushDataUrl(blocks, data);
        return;
      }
      if (mediaLooksLikeImage(mediaType)) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
      } else {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaLooksLikePdf(mediaType, name) ? "application/pdf" : mediaType,
            data,
          },
        });
      }
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

export type HistoryMessage = { role?: string; content?: unknown; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>; tool_call_id?: string; name?: string };

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

export const SYNTHETIC_TOOL_MEDIA_PROMPT = "Attached media from tool result:";

export function isSyntheticToolMediaMessage(
  msg: { role?: string; content?: unknown },
  previous?: { role?: string; content?: unknown },
): boolean {
  if (msg?.role !== "user") return false;
  const text = extractTextContent(msg.content).trim();
  if (text === SYNTHETIC_TOOL_MEDIA_PROMPT) return true;
  return !text && previous?.role === "tool" && contentHasAttachments(msg.content);
}

const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function fingerprintedUserMessages(messages: HistoryMessage[]): Array<{ index: number; print: string }> {
  const entries: Array<{ index: number; print: string }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "user" || isSyntheticToolMediaMessage(msg, messages[i - 1])) continue;
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

const TOOL_PART_TYPES = new Set([
  "text",
  "file",
  "image",
  "image_url",
  "input_file",
  "input_image",
  "document",
]);

export function decodeToolMessageContent(content: unknown): unknown {
  if (Array.isArray(content) && content.length === 1) {
    const only = content[0] as { type?: unknown; text?: unknown } | null;
    if (only?.type === "text" && typeof only.text === "string") {
      const decoded = decodeToolMessageContent(only.text);
      return decoded === only.text ? content : decoded;
    }
  }
  if (typeof content !== "string") return content;
  const text = content.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return content;
  const isPart = (part: unknown): boolean => {
    if (!part || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    if (typeof p.type !== "string" || !TOOL_PART_TYPES.has(p.type)) return false;
    return p.type !== "text" || typeof p.text === "string";
  };
  return parsed.every(isPart) ? parsed : content;
}

export function attachPromotedToolMedia(
  messages: HistoryMessage[],
  toolResults: Map<string, McpToolResultContent[]>,
): number {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const step = messages.slice(lastAssistant + 1);
  const media = step
    .filter((msg, index) =>
      isSyntheticToolMediaMessage(msg, step[index - 1] ?? messages[lastAssistant]),
    )
    .flatMap((msg) =>
      openaiToolResultToMcpContent(msg.content).filter(
        (block) => block.type !== "text",
      ),
    );
  if (media.length === 0) return 0;
  const stepToolIds = step
    .filter((msg) => msg.role === "tool" && msg.tool_call_id)
    .map((msg) => msg.tool_call_id!)
    .filter((id) => toolResults.has(id));
  const target = stepToolIds.at(-1);
  if (!target) return 0;
  const result = toolResults.get(target)!;
  if (stepToolIds.length > 1) {
    result.push({
      type: "text",
      text: "Media attached to the tool results of this step:",
    });
  }
  result.push(...media);
  return media.length;
}

export type ToolStepMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
};

export function answeredToolStepIndex(messages: ToolStepMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const ids = new Set(
      (msg.tool_calls ?? []).map((call) => call?.id).filter(Boolean),
    );
    if (ids.size === 0) return null;
    const answered = messages
      .slice(i + 1)
      .some((m) => m?.role === "tool" && !!m.tool_call_id && ids.has(m.tool_call_id));
    return answered ? i : null;
  }
  return null;
}

const HOST_STOP_NOTE =
  "If your session shows these calls as rejected, or the request as interrupted by the user, that came from the shim (a restart, or a wait that timed out), not from the user: nobody asked you to stop.";

function toolStepBlocks(
  messages: ToolStepMessage[],
  assistantIndex: number,
): { blocks: AnthropicContentBlock[]; userBlocks: AnthropicContentBlock[] } {
  const assistant = messages[assistantIndex]!;
  const blocks: AnthropicContentBlock[] = [];
  const stepText = extractTextContent(assistant.content).trim();
  if (stepText) {
    blocks.push({ type: "text", text: `Your message in that step:\n${stepText}` });
  }
  const calls = new Map(
    (assistant.tool_calls ?? []).map((call) => [call?.id, call?.function]),
  );
  const userBlocks: AnthropicContentBlock[] = [];
  const stepMessages = messages.slice(assistantIndex + 1);
  for (const [index, msg] of stepMessages.entries()) {
    if (msg?.role === "tool" && msg.tool_call_id) {
      const call = calls.get(msg.tool_call_id);
      const result = openaiContentToAnthropicBlocks(decodeToolMessageContent(msg.content));
      blocks.push(
        {
          type: "text",
          text: `Result of ${call?.name ?? msg.name ?? "tool"} ${call?.arguments ?? ""} (${msg.tool_call_id}):`,
        },
        ...(result.length > 0 ? result : [{ type: "text" as const, text: "(no output)" }]),
      );
    } else if (msg && isSyntheticToolMediaMessage(msg, stepMessages[index - 1] ?? messages[assistantIndex])) {
      blocks.push(
        { type: "text", text: "Media attached to these tool results:" },
        ...openaiContentToAnthropicBlocks(msg.content).filter(
          (b) => !(b.type === "text" && b.text.trim() === SYNTHETIC_TOOL_MEDIA_PROMPT),
        ),
      );
    } else if (msg?.role === "user") {
      userBlocks.push(...openaiContentToAnthropicBlocks(msg.content));
    }
  }
  return { blocks, userBlocks };
}

export function answeredToolStepPrompt(
  messages: ToolStepMessage[],
  assistantIndex: number,
  options: { otherModel?: boolean } = {},
): SdkUserPrompt {
  const { blocks, userBlocks } = toolStepBlocks(messages, assistantIndex);
  const content: AnthropicContentBlock[] = [
    {
      type: "text",
      text: options.otherModel
        ? "<tool_results>\nThe model that handled the turns above called the tools below as its last step. Their results are relayed here. Do not repeat a call unless its result requires it."
        : "<tool_results>\nYour previous step called the tools below, but the session that made those calls ended before the client returned their results. They are relayed here. Do not repeat a call unless its result requires it.",
    },
    ...blocks,
    {
      type: "text",
      text:
        userBlocks.length > 0
          ? "</tool_results>\n\nThe user sent the following after those calls. Respond to it with the results in mind:"
          : options.otherModel
            ? "</tool_results>\n\nContinue the task from these results."
            : `</tool_results>\n\n${HOST_STOP_NOTE} Continue the task from these results.`,
    },
    ...userBlocks,
  ];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
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

export function finishReasonFor(stopReason: string | null | undefined): "stop" | "length" | "content_filter" {
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}

export function openAICompletion(
  id: string,
  created: number,
  model: string,
  content: string,
  toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  stopReason?: string | null,
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
        finish_reason: toolCalls.length > 0 ? "tool_calls" : finishReasonFor(stopReason),
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

export function usageFromSdkResult(event: unknown): OpenAIUsage | null {
  const e = event as { usage?: unknown };
  if (!e?.usage || typeof e.usage !== "object") return null;
  return usageFromAnthropic(e.usage as Record<string, unknown>);
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFromAnthropic(usage: Record<string, unknown>): OpenAIUsage {
  const input = asNumber(usage.input_tokens);
  const completion = asNumber(usage.output_tokens);
  const cached = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinking = asNumber(outputDetails?.thinking_tokens);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  const prompt = input + cached + cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(promptDetails).length > 0 ? { prompt_tokens_details: promptDetails } : {}),
    ...(thinking > 0 ? { completion_tokens_details: { reasoning_tokens: thinking } } : {}),
  };
}
