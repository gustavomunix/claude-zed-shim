import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  buildZedMcpServer,
  describeZedTools,
  withStringCoercion,
  type ZedOpenAITool,
} from "../src/tool-bridge.ts";

const tool = (name: string): ZedOpenAITool => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

describe("withStringCoercion", () => {
  const parse = (schema: Record<string, unknown>, value: unknown) => {
    const shape = (
      z.fromJSONSchema(schema as never) as unknown as { loose: () => { parse: (value: unknown) => unknown } }
    ).loose();
    const coerced = withStringCoercion(shape, schema) as { parse: (value: unknown) => unknown };
    return coerced.parse(value);
  };

  it("coerces string arguments before validation", () => {
    assert.deepEqual(parse({ type: "object", properties: { count: { type: "number" } } }, { count: "5" }), { count: 5 });
    assert.deepEqual(parse({ type: "object", properties: { flag: { type: "boolean" } } }, { flag: "true" }), {
      flag: true,
    });
    assert.deepEqual(parse({ type: "object", properties: { items: { type: "array" } } }, { items: "[1]" }), {
      items: [1],
    });
    assert.deepEqual(parse({ type: "object", properties: { obj: { type: "object" } } }, { obj: '{"a":1}' }), {
      obj: { a: 1 },
    });
  });

  it("leaves strings and unions alone", () => {
    assert.deepEqual(parse({ type: "object", properties: { q: { type: "string" } } }, { q: "5" }), { q: "5" });
    assert.deepEqual(
      parse({ type: "object", properties: { q: { anyOf: [{ type: "number" }, { type: "string" }] } } }, { q: "5" }),
      { q: "5" },
    );
  });

  it("preserves schema defaults for omitted keys", () => {
    assert.deepEqual(parse({ type: "object", properties: { count: { type: "number", default: 3 } } }, {}), {
      count: 3,
    });
  });
});

describe("describeZedTools", () => {
  it("marks only read-only tools for parallel execution", () => {
    const listed = describeZedTools([tool("read"), tool("webfetch"), tool("edit")]);
    assert.equal(listed.find((item) => item.name === "read")?.annotations?.readOnlyHint, true);
    assert.equal(listed.find((item) => item.name === "webfetch")?.annotations?.readOnlyHint, true);
    assert.equal(listed.find((item) => item.name === "edit")?.annotations, undefined);
  });

  it("builds both duplicate tools and serves the same list", async () => {
    const first = tool("read");
    const second = tool("read");
    second.function!.description = "second";
    second.function!.parameters = { type: "object", properties: { query: { type: "string" } } };
    const calls: Array<{ name: string; description: string; schema: unknown }> = [];
    let listHandler: (() => Promise<{ tools: unknown }>) | undefined;
    const sdk = {
      createSdkMcpServer: () => ({
        instance: {
          server: {
            setRequestHandler: (_schema: unknown, handler: () => Promise<{ tools: unknown }>) => {
              listHandler = handler;
            },
          },
        },
      }),
      tool: (name: string, description: string, schema: unknown) => {
        calls.push({ name, description, schema });
        return { name };
      },
    };

    await buildZedMcpServer([first, second], new Map(), () => {}, undefined, sdk);
    assert.deepEqual(calls.map((call) => call.description), ["read", "second"]);
    assert.notEqual(calls[0]!.schema, calls[1]!.schema);
    assert.deepEqual(await listHandler!(), { tools: describeZedTools([first, second]) });
  });
});
