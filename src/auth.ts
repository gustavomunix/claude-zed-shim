import { buildClaudeCodeChildEnv } from "./env.ts";
import { resolveClaudeCli, runCliProbe } from "./cli-path.ts";

export const AUTH_OVERRIDE_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

export function interpretClaudeAuthStatus(payload: unknown): {
  loggedIn: boolean;
  detail: string;
  authMethod?: string;
} {
  if (!payload || typeof payload !== "object") {
    return { loggedIn: false, detail: "invalid-auth-status" };
  }
  const root = payload as Record<string, unknown>;
  const loggedIn = Boolean(root.loggedIn);
  const authMethod = typeof root.authMethod === "string" ? root.authMethod : "none";
  const normalized = authMethod.trim().toLowerCase();
  if (!loggedIn) {
    return { loggedIn: false, detail: "auth-status-logged-out", authMethod };
  }
  const apiProvider = typeof root.apiProvider === "string" ? root.apiProvider.trim() : "";
  if (apiProvider && apiProvider !== "firstParty") {
    return { loggedIn: false, detail: "third-party-provider", authMethod };
  }
  if (normalized === "none" || normalized.includes("api") || normalized.includes("console")) {
    return { loggedIn: false, detail: "api-key-only", authMethod };
  }
  const subscription = ["oauth", "claude", "subscription"].some((hint) => normalized.includes(hint));
  return {
    loggedIn: true,
    detail: subscription ? "auth-status-oauth" : "auth-status-logged-in",
    authMethod,
  };
}

export async function probeAuthStatusCli(options: {
  binaryPath: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<{ loggedIn: boolean; detail: string; authMethod?: string } | null> {
  const binaryPath = options.binaryPath.trim();
  if (!binaryPath) return null;
  const result = await runCliProbe(binaryPath, ["auth", "status", "--json"], {
    env: buildClaudeCodeChildEnv(options.env || process.env),
    timeoutMs: 6000,
  });
  if (result.failed && !result.stdout.trim()) return null;
  const output = result.stdout.trim();
  if (!output) return { loggedIn: false, detail: "auth-status-empty" };
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { loggedIn: false, detail: "auth-status-parse-error" };
    }
    try {
      payload = JSON.parse(output.slice(start, end + 1));
    } catch {
      return { loggedIn: false, detail: "auth-status-parse-error" };
    }
  }
  return interpretClaudeAuthStatus(payload);
}

const SUBSCRIPTION_CHECK_TTL_MS = 60_000;
const subscriptionChecks = new Map<string, { at: number; result: Promise<string | null> }>();

type AuthStatus = { loggedIn: boolean; detail: string } | null;
type AuthStatusProbe = (configDir?: string) => AuthStatus | Promise<AuthStatus>;

const defaultAuthStatusProbe: AuthStatusProbe = async (configDir) => {
  const binaryPath = await resolveClaudeCli(process.env);
  if (!binaryPath) return null;
  return probeAuthStatusCli({
    binaryPath,
    env: configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : undefined,
  });
};
let authStatusProbe = defaultAuthStatusProbe;

export function setAuthStatusProbe(probe: AuthStatusProbe | null): void {
  authStatusProbe = probe ?? defaultAuthStatusProbe;
  subscriptionChecks.clear();
}

export function checkSubscriptionAuth(configDir?: string, now = Date.now()): Promise<string | null> {
  const probe = authStatusProbe;
  const key = configDir ?? "";
  const cached = subscriptionChecks.get(key);
  if (cached && now - cached.at < SUBSCRIPTION_CHECK_TTL_MS) {
    return cached.result;
  }
  const result = Promise.resolve().then(async () => {
    let status: AuthStatus = null;
    try {
      status = await probe(configDir);
    } catch {
      status = null;
    }
    if (status?.detail === "api-key-only") {
      return "Claude Code CLI is signed in with an API key. This shim works only with a Claude plan; use the native Anthropic provider for API keys, or run `claude auth login --claudeai`.";
    }
    if (status?.detail === "third-party-provider") {
      return "Claude Code CLI is set to use Bedrock, Vertex or another cloud provider. This shim works only with a Claude plan signed in via `claude auth login --claudeai`.";
    }
    return null;
  });
  subscriptionChecks.set(key, { at: now, result });
  return result;
}
