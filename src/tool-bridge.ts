export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: unknown[]) => void;
  reject: (error: Error) => void;
};

export type ZedOpenAITool = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export function zedToolName(tool: string): string {
  return `mcp__zed__${tool}`;
}

export function openZedToolName(mcpName: string): string {
  return mcpName.replace(/^mcp__zed__/, "");
}

export function normalizeToolParameters(parameters: unknown): Record<string, unknown> {
  if (
    parameters &&
    typeof parameters === "object" &&
    !Array.isArray(parameters) &&
    (parameters as { type?: unknown }).type === "object"
  ) {
    return parameters as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

export const PARALLEL_SAFE_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "codesearch",
  "webfetch",
  "websearch",
  "todoread",
  "skill",
  "lsp_diagnostics",
  "lsp_hover",
  "task",
  "subagent",
]);

export const CLAUDE_TOOL_DESCRIPTION_LIMIT = 8192;

export function fitToolDescription(description: string): string {
  return description.length <= CLAUDE_TOOL_DESCRIPTION_LIMIT ? description : description.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT);
}

function schemaTypes(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const { type, anyOf, oneOf } = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  const variants = [anyOf, oneOf].find(Array.isArray) as unknown[] | undefined;
  if (!variants) return [];
  const types = variants.map(schemaTypes);
  return types.some((t) => t.length === 0) ? [] : types.flat();
}

export function coerceStringArgument(value: unknown, schema: unknown): unknown {
  if (typeof value !== "string") return value;
  const types = schemaTypes(schema);
  if (types.length === 0 || types.includes("string")) return value;
  const text = value.trim();
  if (types.includes("boolean") && (text === "true" || text === "false")) return text === "true";
  if ((types.includes("number") || types.includes("integer")) && text !== "") {
    const number = Number(text);
    if (Number.isFinite(number) && (types.includes("number") || Number.isInteger(number))) return number;
  }
  if (types.includes("null") && text === "null") return null;
  if (types.includes("array") || types.includes("object")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) ? types.includes("array") : parsed !== null && typeof parsed === "object" && types.includes("object")) {
        return parsed;
      }
    } catch {}
  }
  return value;
}

export function buildToolAliases(toolNames: string[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const name of toolNames) {
    const mcpName = zedToolName(name);
    aliases[name] = mcpName;
    const titled = name.charAt(0).toUpperCase() + name.slice(1);
    if (titled !== name) aliases[titled] = mcpName;
    if (name === "bash" || name === "shell") aliases["Bash"] = mcpName;
    if (name === "read") aliases["Read"] = mcpName;
    if (name === "edit") aliases["Edit"] = mcpName;
    if (name === "write") aliases["Write"] = mcpName;
    if (name === "glob") aliases["Glob"] = mcpName;
    if (name === "grep") aliases["Grep"] = mcpName;
  }
  return aliases;
}

export async function buildZedMcpServer(
  tools: ZedOpenAITool[],
  pendingTools: Map<string, ParkedToolCall>,
  onPark: () => void,
  ids?: { nextId?: () => string },
): Promise<Record<string, unknown> | undefined> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod");
    const createSdkMcpServer = (sdk as { createSdkMcpServer?: Function }).createSdkMcpServer;
    const toolFactory = (sdk as { tool?: Function }).tool;
    if (typeof createSdkMcpServer !== "function" || typeof toolFactory !== "function") {
      return undefined;
    }
    const nextId =
      ids?.nextId ?? (() => `call_${Math.random().toString(36).slice(2, 26).padEnd(24, "0")}`);
    const listed: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; _meta: Record<string, unknown> }> = [];
    const mcpTools = tools
      .map((t) => {
        const name = t.function?.name;
        if (!name) return null;
        const description = fitToolDescription(t.function?.description || name);
        const params = normalizeToolParameters(t.function?.parameters);
        listed.push({ name, description, inputSchema: params, _meta: { "anthropic/alwaysLoad": true } });
        let shape: unknown;
        try {
          shape = (z as unknown as { fromJSONSchema: (s: unknown) => { loose: () => unknown } }).fromJSONSchema(params).loose();
        } catch {
          shape = z.object({}).catchall(z.any());
        }
        return toolFactory(
          name,
          description,
          shape,
          async (args: Record<string, unknown>) => {
            const id = nextId();
            const pending: ParkedToolCall = {
              id,
              name,
              arguments: JSON.stringify(args ?? {}),
              resolve: () => {},
              reject: () => {},
            };
            const resultPromise = new Promise<unknown[]>((resolve, reject) => {
              pending.resolve = resolve;
              pending.reject = reject;
            });
            pendingTools.set(id, pending);
            onPark();
            const result = await resultPromise;
            return { content: result.length > 0 ? result : [{ type: "text", text: "" }] };
          },
          { alwaysLoad: true },
        );
      })
      .filter(Boolean);

    const server = createSdkMcpServer({ name: "zed", alwaysLoad: true, tools: mcpTools }) as {
      instance?: { server?: { setRequestHandler?: Function } };
    };
    const mcpServer = server.instance?.server;
    if (typeof mcpServer?.setRequestHandler === "function") {
      mcpServer.setRequestHandler(
        z.object({ method: z.literal("tools/list"), params: z.any().optional() }),
        async () => ({ tools: listed }),
      );
    }
    return { zed: server };
  } catch {
    return undefined;
  }
}
