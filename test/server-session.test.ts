import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockHandle, startTestServer } from "./helpers/server.ts";
import { setClaudeQueryStarter, type StartClaudeQueryParams } from "../src/sdk.ts";

const events = [
  {
    type: "result",
    is_error: false,
    session_id: "s1",
    uuid: "u1",
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: "end_turn",
  },
];

const post = (port: number, messages: unknown[]) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", stream: false, messages }),
  });

describe("session resume", () => {
  it("resumes the stored session and transfers history when the file is gone", async () => {
    const testServer = await startTestServer();
    let captured: StartClaudeQueryParams | undefined;
    try {
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });

      const first = await post(testServer.port, [{ role: "user", content: "one" }]);
      assert.equal(first.status, 200);
      assert.equal(captured?.resume, undefined);

      const project = join(testServer.configDir, "projects", "demo");
      mkdirSync(project, { recursive: true });
      const transcript = join(project, "s1.jsonl");
      writeFileSync(transcript, '{"type":"user","uuid":"u1"}\n');

      const second = await post(testServer.port, [
        { role: "user", content: "one" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "two" },
      ]);
      assert.equal(second.status, 200);
      assert.equal(captured?.resume, "s1");
      assert.equal(typeof captured?.prompt === "string" ? captured.prompt : "", "two");

      rmSync(transcript);
      const third = await post(testServer.port, [
        { role: "user", content: "one" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "two" },
        { role: "assistant", content: "again" },
        { role: "user", content: "three" },
      ]);
      assert.equal(third.status, 200);
      assert.equal(captured?.resume, undefined);
      assert.match(String(captured?.prompt), /User:\none/);
    } finally {
      await testServer.close();
    }
  });
});
