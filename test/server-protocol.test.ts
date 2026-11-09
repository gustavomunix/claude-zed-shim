import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mockHandle, startTestServer } from "./helpers/server.ts";
import { isNarrationSignature } from "../src/server.ts";
import { setClaudeQueryStarter } from "../src/sdk.ts";

const streamEvents = [
  {
    type: "stream_event",
    event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 1 } } },
  },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  },
  {
    type: "stream_event",
    event: { type: "message_delta", usage: { output_tokens: 4 } },
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

const post = (port: number, stream: boolean) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", stream, messages: [{ role: "user", content: "hi" }] }),
  });

describe("usage protocol", () => {
  it("emits usage in the final SSE chunk", async () => {
    const testServer = await startTestServer();
    try {
      setClaudeQueryStarter(async () => mockHandle(streamEvents));
      const response = await post(testServer.port, true);
      assert.equal(response.status, 200);
      const chunks = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      const last = chunks.at(-1)!;
      assert.equal(last.choices[0].finish_reason, "stop");
      assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
      assert.ok(!chunks.some((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0));
    } finally {
      await testServer.close();
    }
  });

  it("maps max_tokens to length in streaming", async () => {
    const testServer = await startTestServer();
    try {
      const events = [
        streamEvents[0]!,
        streamEvents[1]!,
        {
          type: "stream_event",
          event: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4 } },
        },
        { type: "result", is_error: false, usage: { input_tokens: 10, output_tokens: 4 }, stop_reason: "max_tokens" },
      ];
      setClaudeQueryStarter(async () => mockHandle(events));
      const response = await post(testServer.port, true);
      const chunks = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)));
      assert.equal(chunks.at(-1)!.choices[0].finish_reason, "length");
    } finally {
      await testServer.close();
    }
  });

  it("recognizes narration signatures", () => {
    assert.equal(isNarrationSignature(Buffer.from("narration:hello").toString("base64")), true);
    assert.equal(isNarrationSignature(Buffer.from("thinking").toString("base64")), false);
    assert.equal(isNarrationSignature(undefined), false);
  });

  it("maps max_tokens to length without streaming", async () => {
    const testServer = await startTestServer();
    try {
      setClaudeQueryStarter(async () =>
        mockHandle([
          { type: "result", is_error: false, usage: { input_tokens: 10, output_tokens: 4 }, stop_reason: "max_tokens" },
        ]),
      );
      const response = await post(testServer.port, false);
      const body = (await response.json()) as { choices: Array<{ finish_reason: string }> };
      assert.equal(body.choices[0]!.finish_reason, "length");
    } finally {
      await testServer.close();
    }
  });

  it("surfaces a result error instead of treating it as usage", async () => {
    const testServer = await startTestServer();
    try {
      setClaudeQueryStarter(async () =>
        mockHandle([{ type: "result", is_error: true, error: "boom", usage: { input_tokens: 1, output_tokens: 1 } }]),
      );
      const response = await post(testServer.port, false);
      assert.equal(response.status, 500);
    } finally {
      await testServer.close();
    }
  });

  it("emits usage in a non-streaming response", async () => {
    const testServer = await startTestServer();
    try {
      setClaudeQueryStarter(async () => mockHandle(streamEvents));
      const response = await post(testServer.port, false);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { usage: unknown };
      assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
    } finally {
      await testServer.close();
    }
  });
});
