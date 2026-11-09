import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LeafChainState = "clean" | "branched" | "missing";

export function findClaudeSessionFile(sessionId: string, configDir?: string): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  const root = configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const projectsDir = join(root, "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function sessionFileHasEntry(file: string, uuid: string, chunkBytes = 256 * 1024): boolean {
  const needle = Buffer.from(`"uuid":"${uuid}"`, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const window = Buffer.concat([chunk, carry]);
      if (window.includes(needle)) return true;
      carry = window.subarray(0, Math.min(window.length, needle.length - 1));
      end = start;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function sessionChainAfterLeaf(file: string, leafUuid: string, chunkBytes = 256 * 1024): LeafChainState {
  const needle = Buffer.from(`"uuid":"${leafUuid}"`, "utf8");
  let fd: number | undefined;
  let tail: Buffer | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    let window = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      window = Buffer.concat([chunk, window]);
      end = start;
      const at = window.lastIndexOf(needle);
      if (at < 0) continue;
      const lineStart = window.lastIndexOf(0x0a, at);
      if (lineStart < 0 && start > 0) continue;
      const lineEnd = window.indexOf(0x0a, at);
      tail = lineEnd < 0 ? Buffer.alloc(0) : window.subarray(lineEnd + 1);
      break;
    }
  } catch {
    return "missing";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!tail) return "missing";
  const chain = new Set([leafUuid]);
  let lastPromptLeaf: string | undefined;
  for (const line of tail.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "last-prompt" && typeof entry.leafUuid === "string") {
      lastPromptLeaf = entry.leafUuid;
      continue;
    }
    const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
    if (!uuid || entry.isSidechain === true) continue;
    const parent =
      typeof entry.parentUuid === "string"
        ? entry.parentUuid
        : typeof entry.logicalParentUuid === "string"
          ? entry.logicalParentUuid
          : undefined;
    if (parent && chain.has(parent)) {
      chain.add(uuid);
      continue;
    }
    if (isChainMessage(entry)) return "branched";
  }
  return lastPromptLeaf && !chain.has(lastPromptLeaf) ? "branched" : "clean";
}

export function lastChainEntryUuid(file: string, chunkBytes = 256 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      end = start;
      const window = Buffer.concat([chunk, rest]);
      const lines = window.toString("utf8").split("\n");
      const head = start > 0 ? (lines.shift() ?? "") : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const uuid = chainEntryUuid(lines[i]!);
        if (uuid) return uuid;
      }
      rest = Buffer.from(head, "utf8");
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isChainMessage(entry: Record<string, unknown>): boolean {
  return (
    entry.type === "user" ||
    entry.type === "assistant" ||
    (entry.type === "system" && entry.subtype === "compact_boundary")
  );
}

function chainEntryUuid(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.uuid !== "string" || entry.isSidechain === true) return undefined;
    return isChainMessage(entry) ? entry.uuid : undefined;
  } catch {
    return undefined;
  }
}
