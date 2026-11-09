const REDACTED_KEYS = new Set([
  "prompt",
  "content",
  "authorization",
  "token",
  "apikey",
  "cookie",
  "password",
  "secret",
  "xapikey",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = REDACTED_KEYS.has(normalizeKey(key)) ? "[redacted]" : redact(item, depth + 1);
  }
  return result;
}

export function debugEnabled(): boolean {
  return process.env.CLAUDE_ZED_DEBUG === "1";
}

export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!debugEnabled()) return;
  try {
    const payload = { ...(redact(data) as Record<string, unknown>), ts: Date.now(), event };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
  }
}
