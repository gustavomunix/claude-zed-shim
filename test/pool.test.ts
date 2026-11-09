import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acquireSpawnLock,
  findBridgeByConversation,
  putBridge,
  stopConversationBridges,
  type ParkedBridge,
} from "../src/pool.ts";

describe("acquireSpawnLock", () => {
  it("serializes two acquires on same key", async () => {
    const order: string[] = [];
    const release1 = await acquireSpawnLock("k");
    const p2 = acquireSpawnLock("k").then((release2) => {
      order.push("second");
      release2();
    });
    order.push("first");
    release1();
    await p2;
    assert.deepEqual(order, ["first", "second"]);
  });
  it("release is idempotent", async () => {
    const release = await acquireSpawnLock("k2");
    release();
    release();
    const release2 = await acquireSpawnLock("k2");
    release2();
  });
});

describe("stopConversationBridges", () => {
  it("rejects pending tools and removes the bridge", async () => {
    const rejections: Error[] = [];
    const handle = {
      stream: (async function* () {})(),
      interrupt: async () => {},
      close: () => {},
      getPid: () => null,
      stop: async () => {},
      onEvent: () => {},
    };
    const bridge: ParkedBridge = {
      id: "b1",
      conversationKey: "parked",
      handle,
      pendingTools: new Map([
        [
          "call-1",
          {
            id: "call-1",
            name: "read",
            arguments: "{}",
            resolve: () => {},
            reject: (error: Error) => rejections.push(error),
          },
        ],
      ]),
      reportedUsage: new Map(),
      forwardedSteering: new Set(),
      createdAt: Date.now(),
    };
    putBridge(bridge);
    await stopConversationBridges("parked", "test");
    assert.equal(rejections.length, 1);
    assert.equal(findBridgeByConversation("parked"), undefined);
  });
});
