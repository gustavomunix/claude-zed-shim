const REDACTED_KEYS = new Set(["prompt", "content", "authorization", "token", "apiKey", "api_key"]);

export function debugEnabled(): boolean {
  return process.env.CLAUDE_ZED_DEBUG === "1";
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!debugEnabled()) return;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    safe[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
  }
  process.stderr.write(`${JSON.stringify({ ts: Date.now(), event, ...safe })}\n`);
}
