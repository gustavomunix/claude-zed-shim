import { buildConversationTranscript, extractTextContent, type HistoryMessage } from "./translate.ts";

export type MetaRequestKind = "title" | "summary" | "commit" | null;

export const UTILITY_SYSTEM_PROMPT =
  "You are a text generation helper running through the Claude Code harness. Follow the instructions in the user message and return only the requested output.";

const TITLE_MARKER = "Generate a concise 3-7 word title for this conversation";
const SUMMARY_MARKERS = [
  "Summarize the conversation so far to free up context",
  "Compact the conversation so far.",
  "Generate a detailed summary of this conversation",
  "You are compacting this conversation into a handoff",
];
const COMMIT_MARKER = "You are an expert at writing Git commits.";

function systemText(messages: HistoryMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => extractTextContent(message.content))
    .join("\n");
}

function latestUserText(messages: HistoryMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return extractTextContent(messages[i]!.content).trim();
  }
  return "";
}

export function detectMetaRequestKind(messages: HistoryMessage[]): MetaRequestKind {
  const text = latestUserText(messages);
  if (text.includes(TITLE_MARKER)) return "title";
  if (text.includes(COMMIT_MARKER)) return "commit";
  if (SUMMARY_MARKERS.some((marker) => text.includes(marker))) return "summary";
  return null;
}

const DEFAULT_TITLE_INSTRUCTIONS =
  "Create a concise 3-7 word title for the request below. Output only the title, with no quotation marks.";
const DEFAULT_SUMMARY_INSTRUCTIONS =
  "Summarize the conversation below. Return only the summary requested by the final message.";

export function buildMetaPrompt(kind: Exclude<MetaRequestKind, null>, messages: HistoryMessage[]): string {
  const system = kind === "summary" ? "" : systemText(messages).trim();
  const instructions =
    system ||
    (kind === "title"
      ? DEFAULT_TITLE_INSTRUCTIONS
      : kind === "summary"
        ? DEFAULT_SUMMARY_INSTRUCTIONS
        : "Follow the instructions in the request below.");
  const history =
    kind === "commit"
      ? ""
      : buildConversationTranscript(messages.slice(0, -1).filter((message) => message.role !== "system")).trim();
  const context = history ? `<conversation_history>\n${history}\n</conversation_history>\n\n` : "";
  return `<instructions>\n${instructions}\n</instructions>\n\n${context}${latestUserText(messages)}`;
}
