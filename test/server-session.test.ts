import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mockHandle, promptText, startTestServer } from "./helpers/server.ts";
import { findBridgeByConversation } from "../src/pool.ts";
import { conversationKey, getSessionTurns } from "../src/store.ts";
import { userHistoryFingerprints } from "../src/translate.ts";
import { setClaudeQueryStarter, setClaudeSessionForker, type StartClaudeQueryParams } from "../src/sdk.ts";

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
      assert.deepEqual(captured?.settingSources, ["project"]);
      assert.equal(
        findBridgeByConversation(conversationKey([{ role: "user", content: "one" }], "claude-opus-5-5")),
        undefined,
      );

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
      assert.match(await promptText(captured?.prompt), /User:\none/);
    } finally {
      await testServer.close();
    }
  });

  it("forks a branched rewind and transfers history when the fork fails", async () => {
    const testServer = await startTestServer();
    let captured: StartClaudeQueryParams | undefined;
    try {
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      await post(testServer.port, [{ role: "user", content: "one" }]);

      const project = join(testServer.configDir, "projects", "demo");
      mkdirSync(project, { recursive: true });
      const transcript = join(project, "s1.jsonl");
      writeFileSync(transcript, '{"type":"user","uuid":"u1"}\n');
      await post(testServer.port, [
        { role: "user", content: "one" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "two" },
      ]);
      appendFileSync(transcript, '{"type":"assistant","uuid":"u2","parentUuid":"u1"}\n');

      const rewind = [
        { role: "user", content: "one" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "edited" },
      ];

      writeFileSync(join(project, "forked.jsonl"), '{"type":"user","uuid":"f1"}\n');
      setClaudeSessionForker(async () => "forked");
      await post(testServer.port, rewind);
      assert.equal(captured?.resume, "forked");

      setClaudeSessionForker(async () => {
        throw new Error("fork failed");
      });
      await post(testServer.port, rewind);
      assert.equal(captured?.resume, undefined);
      assert.match(await promptText(captured?.prompt), /User:\none/);
    } finally {
      await testServer.close();
    }
  });

  it("rewinds in place when the chain is clean and ends at the leaf", async () => {
    const testServer = await startTestServer();
    let captured: StartClaudeQueryParams | undefined;
    try {
      setClaudeQueryStarter(async (params) => {
        captured = params;
        return mockHandle(events);
      });
      await post(testServer.port, [{ role: "user", content: "one" }]);

      const project = join(testServer.configDir, "projects", "demo");
      mkdirSync(project, { recursive: true });
      const transcript = join(project, "s1.jsonl");
      writeFileSync(transcript, '{"type":"user","uuid":"u1"}\n');
      await post(testServer.port, [
        { role: "user", content: "one" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "two" },
      ]);

      const rewind = [
        { role: "user", content: "one" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "edited" },
      ];
      await post(testServer.port, rewind);
      assert.equal(captured?.resume, "s1");
      const hashes = getSessionTurns(conversationKey(rewind, "claude-opus-5-5")).map((turn) => turn.hash);
      assert.equal(hashes.includes(userHistoryFingerprints([{ role: "user", content: "two" }])[0]!), false);
      assert.equal(hashes.length, 2);
    } finally {
      await testServer.close();
    }
  });
});
