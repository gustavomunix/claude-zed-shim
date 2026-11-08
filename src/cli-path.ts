import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeCodeChildEnv } from "./env.ts";

type ProbeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type CliProbeResult = {
  status: number | null;
  stdout: string;
  failed: boolean;
};

const MAX_PROBE_OUTPUT = 64 * 1024;

export function isJsEntrypoint(path: string): boolean {
  return /\.[cm]?js$/i.test(path);
}

export function cliInvocation(binaryPath: string, args: string[]): [string, string[]] {
  return isJsEntrypoint(binaryPath) ? ["node", [binaryPath, ...args]] : [binaryPath, args];
}

export function runCliProbe(
  command: string,
  args: string[],
  options: { env?: ProbeEnv; timeoutMs: number },
): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (status: number | null, failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, failed });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish(null, true);
    }, options.timeoutMs);
    timer.unref?.();
    try {
      const [file, argv] = cliInvocation(command, args);
      child = spawn(file, argv, {
        env: options.env as NodeJS.ProcessEnv | undefined,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null, true);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += chunk;
    });
    child.once("error", () => finish(null, true));
    child.once("close", (code: number | null) => finish(code, false));
  });
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeClaude(candidate: string, env: ProbeEnv): Promise<boolean> {
  const result = await runCliProbe(candidate, ["--version"], {
    env: buildClaudeCodeChildEnv(env),
    timeoutMs: 4000,
  });
  if (result.failed) return false;
  return result.status === 0 || Boolean(result.stdout.trim());
}

export async function resolveWindowsClaudePath(candidate: string): Promise<string | null> {
  if (!(await isExecutableFile(candidate))) return null;
  if (/\.exe$/i.test(candidate)) return candidate;
  if (!/\.(cmd|bat)$/i.test(candidate)) return null;
  const pkg = join(dirname(candidate), "node_modules", "@anthropic-ai", "claude-code");
  for (const target of [join(pkg, "bin", "claude.exe"), join(pkg, "cli.js")]) {
    if (await isExecutableFile(target)) return target;
  }
  return null;
}

async function usableClaudePath(candidate: string, env: ProbeEnv): Promise<string | null> {
  if (process.platform === "win32") return resolveWindowsClaudePath(candidate);
  return (await isExecutableFile(candidate)) && (await probeClaude(candidate, env)) ? candidate : null;
}

async function knownClaudeLocations(env: ProbeEnv): Promise<string[]> {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  if (process.platform === "win32") {
    const appData =
      typeof env.APPDATA === "string" && env.APPDATA ? env.APPDATA : join(home, "AppData", "Roaming");
    return [
      join(home, ".local", "bin", "claude.exe"),
      join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      join(appData, "npm", "claude.cmd"),
    ];
  }
  return [join(home, ".local", "bin", "claude")];
}

export async function findBinaryOnPath(name: string, env: ProbeEnv = process.env): Promise<string | null> {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}${ext}`;
      const usable = await usableClaudePath(candidate, env);
      if (usable) return usable;
    }
  }
  if (process.platform === "win32") return null;
  return (await probeClaude(name, env)) ? name : null;
}

const MISS_CACHE_MS = 60_000;
let cachedResolution: { key: string; path: string | null; expiresAt: number } | null = null;
let inflight: { key: string; promise: Promise<string | null> } | null = null;

export function resolveClaudeCli(env: ProbeEnv = process.env): Promise<string | null> {
  const key = `${env.PATH ?? ""}\0${env.HOME ?? ""}`;
  if (cachedResolution && cachedResolution.key === key && Date.now() < cachedResolution.expiresAt) {
    return Promise.resolve(cachedResolution.path);
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = probeClaudeCli(env).then(
    (path) => {
      if (inflight?.promise === promise) {
        inflight = null;
        cachedResolution = {
          key,
          path,
          expiresAt: path ? Number.POSITIVE_INFINITY : Date.now() + MISS_CACHE_MS,
        };
      }
      return path;
    },
    (error) => {
      if (inflight?.promise === promise) inflight = null;
      throw error;
    },
  );
  inflight = { key, promise };
  return promise;
}

async function probeClaudeCli(env: ProbeEnv): Promise<string | null> {
  let resolved = await findBinaryOnPath("claude", env);
  if (!resolved) {
    for (const candidate of await knownClaudeLocations(env)) {
      resolved = await usableClaudePath(candidate, env);
      if (resolved) break;
    }
  }
  return resolved;
}

export function resetClaudeCliResolutionCache(): void {
  cachedResolution = null;
  inflight = null;
}

export function resolveClaudeCodeExecutable(options?: { env?: ProbeEnv }): Promise<string | null> {
  return resolveClaudeCli(options?.env ?? process.env);
}

export function assertClaudeWorkingDirectory(cwd: unknown): string {
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
}
