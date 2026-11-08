import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { modelsFromSdk, modelCachePath, invalidateModelsCache, getClaudeModels } from "../src/models.ts";

describe("modelCachePath", () => {
  it("keeps legacy path when CLAUDE_CONFIG_DIR is unset", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const legacy = modelCachePath();
      assert.ok(legacy.includes("claude-zed-shim") && !legacy.includes(".claude-account"));
      assert.ok(legacy.endsWith(join("claude-zed-shim", "models.json")));
    } finally {
      if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
  it("partitions by CLAUDE_CONFIG_DIR", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      const legacy = modelCachePath();
      process.env.CLAUDE_CONFIG_DIR = "C:\\Users\\x\\.claude-account2";
      const withAcc2 = modelCachePath();
      process.env.CLAUDE_CONFIG_DIR = "C:\\Users\\x\\.claude-account3";
      const withAcc3 = modelCachePath();
      assert.notEqual(withAcc2, legacy);
      assert.notEqual(withAcc3, legacy);
      assert.notEqual(withAcc2, withAcc3);
    } finally {
      if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

describe("invalidateModelsCache", () => {
  it("re-reads the partitioned cache file after env change", () => {
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousCfg = process.env.CLAUDE_CONFIG_DIR;
    const sandbox = join(process.cwd(), ".superpowers", "sdd", "2026-11-08-claude-zed-shim-multi-account", "models-cache-sandbox");
    try {
      process.env.CLAUDE_CONFIG_DIR = "C:\\tmp\\acc-x";
      process.env.XDG_DATA_HOME = sandbox;
      const path = modelCachePath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify([{ id: "probe-model-x", name: "Probe X" }]));
      invalidateModelsCache();
      assert.ok(getClaudeModels().some((m) => m.id === "probe-model-x"));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      if (previousXdg !== undefined) process.env.XDG_DATA_HOME = previousXdg;
      else delete process.env.XDG_DATA_HOME;
      if (previousCfg !== undefined) process.env.CLAUDE_CONFIG_DIR = previousCfg;
    }
  });
});

describe("modelsFromSdk", () => {
  it("dedupes alias + concrete, applies 1m default, adds fast neighbor", () => {
    const rows = [
      { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["high"], supportsFastMode: true },
      { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["high"], supportsFastMode: true },
      { value: "claude-sonnet-4-6[1m]", resolvedModel: "claude-sonnet-4-6", supportedEffortLevels: ["low"] },
    ];
    const models = modelsFromSdk(rows);
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("claude-opus-5-5"));
    assert.ok(ids.includes("claude-opus-5-5:fast"));
    assert.ok(ids.includes("claude-sonnet-4-6[1m]"));
    assert.equal(new Set(ids).size, ids.length);
  });
  it("skips default row", () => {
    assert.deepEqual(modelsFromSdk([{ value: "default" }]), []);
  });
});
