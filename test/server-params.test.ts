import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mockHandle, promptText, startTestServer } from "./helpers/server.ts";
import { setClaudeQueryStarter, type StartClaudeQueryParams } from "../src/sdk.ts";
import { setDiscoveredModels, modelsFromSdk, invalidateModelsCache, type SdkModelRow } from "../src/models.ts";
import { findBridgeByConversation } from "../src/pool.ts";
import { conversationKey } from "../src/store.ts";

const events = [
  {
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  },
  {
    type: "result",
    is_error: false,
    session_id: "s1",
    uuid: "u1",
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: "end_turn",
  },
];

const post = (port: number, body: Record<string, unknown>) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", stream: false, messages: [{ role: "user", content: "hi" }], ...body }),
  });

const KEY = conversationKey([{ role: "user", content: "hi" }], "claude-opus-5-5");

const systemPromptText = (params: StartClaudeQueryParams | undefined): string => {
  const prompt = params?.systemPrompt;
  if (typeof prompt === "string") return prompt;
  return prompt?.append ?? "";
};

describe("openai parameters mapped to the claude sdk", () => {
  it("does not set verbatimPrompts; plain user turns stay as they were", async () => {
    const testServer = await startTestServer();
    try {
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      const response = await post(testServer.port, {});
      assert.equal(response.status, 200);
      assert.equal((captured?.prompt as { client_composed?: boolean } | undefined)?.client_composed, undefined);
    } finally {
      await testServer.close();
    }
  });

  it("passes response_format json_schema through as outputFormat and serializes structured_output", async () => {
    const testServer = await startTestServer();
    try {
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle([{ ...events[2]!, structured_output: { a: 1 } }]);
      });
      const response = await post(testServer.port, {
        response_format: {
          type: "json_schema",
          json_schema: { name: "Out", schema: { type: "object", properties: { a: { type: "number" } } } },
        },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(captured?.outputFormat, {
        type: "json_schema",
        schema: { type: "object", properties: { a: { type: "number" } } },
      });
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      assert.deepEqual(JSON.parse(body.choices[0]!.message.content), { a: 1 });
    } finally {
      await testServer.close();
    }
  });

  it("rejects unsupported response_format values with a 400", async () => {
    const testServer = await startTestServer();
    try {
      setClaudeQueryStarter(async () => mockHandle(events));
      const response = await post(testServer.port, { response_format: { type: "json_object" } });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /json_schema/);
    } finally {
      await testServer.close();
    }
  });

  it("maps tool_choice none to no registered tools", async () => {
    const testServer = await startTestServer();
    try {
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      const response = await post(testServer.port, {
        tool_choice: "none",
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      });
      assert.equal(response.status, 200);
      assert.equal(captured?.mcpServers, undefined);
      assert.equal(captured?.allowedTools, undefined);
      assert.match(systemPromptText(captured), /Built-in Claude Code tools are disabled/);
      assert.doesNotMatch(systemPromptText(captured), /Batch/);
    } finally {
      await testServer.close();
    }
  });

  it("instructs one tool call at a time when parallel_tool_calls is false", async () => {
    const testServer = await startTestServer();
    try {
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      const response = await post(testServer.port, {
        parallel_tool_calls: false,
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      });
      assert.equal(response.status, 200);
      assert.match(systemPromptText(captured), /one tool call at a time/);
      assert.doesNotMatch(systemPromptText(captured), /Batch/);
    } finally {
      await testServer.close();
    }
  });

  it("keeps the batching instruction when parallel_tool_calls is not false", async () => {
    const testServer = await startTestServer();
    try {
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      const response = await post(testServer.port, {
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      });
      assert.equal(response.status, 200);
      assert.match(systemPromptText(captured), /Batch independent tool calls/);
    } finally {
      await testServer.close();
    }
  });

  it("reads reasoning.effort when reasoning_effort is absent", async () => {
    const { parseChatBody } = await import("../src/server.ts");
    const body = parseChatBody({ model: "m", messages: [{ role: "user", content: "hi" }], reasoning: { effort: "max" } });
    assert.equal(body.reasoning_effort, "max");
  });

  it("surfaces api_retry frames as SSE comments", async () => {
    const testServer = await startTestServer();
    try {
      const retryEvent = {
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 8000,
        error_status: 429,
      };
      setClaudeQueryStarter(async () => mockHandle([...events.slice(0, 2), retryEvent]));
      const response = await fetch(`http://127.0.0.1:${testServer.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /: retry 429 attempt 2\/10 in 8s/);
    } finally {
      await testServer.close();
    }
  });

  it("classifies api errors from result.errors", async () => {
    const testServer = await startTestServer();
    try {
      const errorResult = {
        type: "result",
        is_error: true,
        errors: ["Rate limit exceeded, try again at 12:00"],
        uuid: "u1",
        session_id: "s1",
        subtype: "error_during_execution",
      };
      setClaudeQueryStarter(async () => mockHandle([errorResult]));
      const response = await post(testServer.port, {});
      assert.equal(response.status, 429);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /Rate limit/);
    } finally {
      await testServer.close();
    }
  });

  it("stops the turn when a streaming client disconnects", async () => {
    const testServer = await startTestServer();
    const previousGrace = process.env.OPENCODE_CLAUDE_STOP_GRACE_MS;
    process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "0";
    const heldRef: { release: (() => void) | null } = { release: null };
    try {
      setClaudeQueryStarter(async () => {
        const listeners: Array<(event: unknown) => void> = [];
        const held = new Promise<void>((resolve) => (heldRef.release = resolve));
        return {
          stream: (async function* () {
            for (const event of events.slice(0, 2)) {
              for (const listener of listeners) listener(event);
              yield event;
            }
            await held;
          })(),
          interrupt: async () => {},
          close: () => heldRef.release?.(),
          getPid: () => null,
          onEvent: (listener: (event: unknown) => void) => listeners.push(listener),
        };
      });
      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${testServer.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
        signal: controller.signal,
      }).catch(() => null);
      const deadline = Date.now() + 2_000;
      while (!findBridgeByConversation(KEY) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const bridge = findBridgeByConversation(KEY);
      assert.ok(bridge);
      assert.equal(bridge.pendingTools.size, 0);
      controller.abort();
      void (await response);
      const stoppedAt = Date.now();
      while (findBridgeByConversation(KEY) && Date.now() - stoppedAt < 2_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.ok(!findBridgeByConversation(KEY), "bridge should be removed after the client disconnected");
    } finally {
      heldRef.release?.();
      if (previousGrace === undefined) delete process.env.OPENCODE_CLAUDE_STOP_GRACE_MS;
      else process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = previousGrace;
      await testServer.close();
    }
  });

  it("turns fast mode on for :fast model ids", async () => {
    const testServer = await startTestServer();
    try {
      const rows: SdkModelRow[] = [{ value: "claude-opus-5-5", supportsFastMode: true }];
      setDiscoveredModels(modelsFromSdk(rows));
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      const response = await fetch(`http://127.0.0.1:${testServer.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5:fast", stream: false, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      assert.equal(captured?.fastMode, true);
      assert.equal(captured?.model, "claude-opus-5-5");
    } finally {
      invalidateModelsCache();
      await testServer.close();
    }
  });

  it("marks meta prompts as client_composed", async () => {
    const testServer = await startTestServer();
    try {
      let captured: StartClaudeQueryParams | undefined;
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      const response = await post(testServer.port, {
        messages: [
          { role: "system", content: "Generate a concise 3-7 word title for this conversation" },
          { role: "user", content: "Generate a concise 3-7 word title for this conversation: hello world" },
        ],
      });
      assert.equal(response.status, 200);
      assert.match(await promptText(captured?.prompt), /title/);
    } finally {
      await testServer.close();
    }
  });
});
