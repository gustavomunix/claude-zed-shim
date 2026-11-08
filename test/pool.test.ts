import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { acquireSpawnLock } from "../src/pool.ts";

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
