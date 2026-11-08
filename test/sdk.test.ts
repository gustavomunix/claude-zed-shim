import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withGracefulStop } from "../src/sdk.ts";

describe("withGracefulStop", () => {
  it("interrupt runs before close on stop", async () => {
    const order: string[] = [];
    let closed = false;
    const events: unknown[] = [{ type: "result" }];
    const handle = {
      stream: (async function* () {
        yield* events;
      })(),
      interrupt: async () => {
        order.push("interrupt");
      },
      close: () => {
        order.push("close");
        closed = true;
      },
      getPid: () => null,
    };
    const stoppable = withGracefulStop(handle);
    await stoppable.stop(100);
    assert.deepEqual(order, ["interrupt", "close"]);
    assert.equal(closed, true);
  });
  it("passes through handles that already stop", async () => {
    const handle = {
      stream: (async function* () {})(),
      interrupt: async () => {},
      close: () => {},
      getPid: () => null,
      stop: async () => {},
      onEvent: (_l: (e: unknown) => void) => {},
    };
    assert.equal(withGracefulStop(handle), handle);
  });
});
