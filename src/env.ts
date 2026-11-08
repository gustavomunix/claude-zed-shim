export const MCP_DESCRIPTION_LIMIT = 8192;

export function buildClaudeCodeChildEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH?.trim()) {
    env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(MCP_DESCRIPTION_LIMIT);
  }
  if (!env.MAX_MCP_OUTPUT_TOKENS?.trim()) {
    env.MAX_MCP_OUTPUT_TOKENS = "200000";
  }
  return env;
}
