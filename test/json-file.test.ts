import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonFile, writeJsonFileAtomic } from "../src/json-file.ts";

describe("json-file", () => {
  it("writes and reads an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-json-"));
    try {
      const path = join(dir, "nested", "value.json");
      writeJsonFileAtomic(path, { hello: "world" });
      assert.deepEqual(readJsonFile(path), { hello: "world" });
      assert.match(readFileSync(path, "utf8"), /"hello": "world"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for missing or invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-json-"));
    try {
      assert.equal(readJsonFile(join(dir, "missing.json")), null);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ nope");
      assert.equal(readJsonFile(bad), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces the old value", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-zed-json-"));
    try {
      const path = join(dir, "value.json");
      writeJsonFileAtomic(path, { version: 1 });
      writeJsonFileAtomic(path, { version: 2 });
      assert.deepEqual(readJsonFile(path), { version: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
