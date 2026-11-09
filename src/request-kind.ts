import { extractTextContent, type HistoryMessage } from "./translate.ts";

export type MetaRequestKind = "title" | "summary" | "commit" | null;

export const UTILITY_SYSTEM_PROMPT =
  "You are a text generation helper running through the Claude Code harness. Follow the instructions in the user message and return only the requested output.";

const TITLE_MARKER = "Generate a concise 3-7 word title for this conversation";
const SUMMARY_MARKERS = [
  "Summarize the conversation so far to free up context",
  "Compact the conversation so far.",
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
  const system = systemText(messages);
  if (system.includes(TITLE_MARKER)) return "title";
  if (system.includes(COMMIT_MARKER)) return "commit";
  if (SUMMARY_MARKERS.some((marker) => system.includes(marker))) return "summary";
  return null;
}

const DEFAULT_TITLE_INSTRUCTIONS =
  "Create a concise 3-7 word title for the request below. Output only the title, with no quotation marks.";

export function buildMetaPrompt(kind: Exclude<MetaRequestKind, null>, messages: HistoryMessage[]): string {
  const system = systemText(messages).trim();
  const instructions = system || (kind === "title" ? DEFAULT_TITLE_INSTRUCTIONS : "Follow the instructions in the request below.");
  return `<instructions>\n${instructions}\n</instructions>\n\n${latestUserText(messages)}`;
}
