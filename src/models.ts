import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { listClaudeSupportedModels } from "./sdk.ts";

export const FAST_MODEL_SUFFIX = ":fast";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof EFFORT_LEVELS)[number];
export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
  efforts?: ClaudeEffort[];
  fast?: boolean;
};

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
  efforts: ClaudeEffort[] = [...EFFORT_LEVELS],
): ClaudeModel {
  return {
    id,
    name,
    reasoning: efforts.length > 0,
    contextWindow: limit.context,
    maxTokens: limit.output,
    efforts,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

const FALLBACK_MODELS: ClaudeModel[] = [
  model("claude-opus-5-5", "Opus 5.5", LIMIT_1M),
  model("claude-sonnet-5-5", "Sonnet 5.5", LIMIT_1M),
  model("claude-sonnet-5", "Sonnet 5", LIMIT_1M),
  model("claude-haiku-5-5", "Haiku 5.5", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K, undefined, []),
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
];

export type SdkModelRow = {
  value: string;
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
};

const ONE_M_FAMILIES: Array<{ match: RegExp; mode: "default" | "optional" | "fixed" }> = [
  { match: /^claude-opus-5/, mode: "fixed" },
  { match: /^claude-opus-4-[78]/, mode: "fixed" },
  { match: /^claude-opus-4-6/, mode: "optional" },
  { match: /^claude-sonnet-5/, mode: "fixed" },
  { match: /^claude-haiku-5/, mode: "fixed" },
];

export function modelNameFromId(id: string | undefined): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(id?.trim() ?? "");
  if (!match) return undefined;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

export function modelsFromSdk(rows: SdkModelRow[]): ClaudeModel[] {
  const out: ClaudeModel[] = [];
  for (const row of rows) {
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    if (!value || value === "default") continue;
    const efforts = (row.supportedEffortLevels ?? []).filter(isClaudeEffort);
    const name =
      modelNameFromId(row.resolvedModel) ?? modelNameFromId(value) ?? (row.displayName?.trim() || value);
    const family = (row.resolvedModel || value).replace(/\[1m\]$/i, "");
    const base = family;
    const rule = /\[1m\]$/i.test(value)
      ? { mode: "default" as const }
      : ONE_M_FAMILIES.find((f) => f.match.test(family));
    if (rule?.mode === "default") {
      out.push(model(`${base}[1m]`, name, LIMIT_1M, undefined, efforts));
    } else if (rule?.mode === "fixed") {
      out.push(model(base, name, LIMIT_1M, undefined, efforts));
    } else if (rule?.mode === "optional") {
      out.push(model(base, name, LIMIT_200K, undefined, efforts));
      out.push(model(`${base}[1m]`, `${name} (1M)`, LIMIT_1M, undefined, efforts));
    } else {
      out.push(model(base, name, LIMIT_200K, undefined, efforts));
    }
  }
  const seen = new Set<string>();
  const unique = out.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const fastFamilies = new Set(
    rows
      .filter((row) => row?.supportsFastMode === true)
      .map((row) => (row.resolvedModel || row.value || "").trim().replace(/\[1m\]$/i, ""))
      .filter((id) => id && id !== "default"),
  );
  return unique.flatMap((m) =>
    fastFamilies.has(m.id.replace(/\[1m\]$/i, ""))
      ? [m, { ...m, id: `${m.id}${FAST_MODEL_SUFFIX}`, name: `${m.name} Fast`, resolvedId: m.id, fast: true }]
      : [m],
  );
}

let discovered: ClaudeModel[] | null = readCachedModels();

function buildCatalog(): ClaudeModel[] {
  return discovered?.length ? discovered : FALLBACK_MODELS;
}

export function getClaudeModels(): ClaudeModel[] {
  return buildCatalog();
}

export function setDiscoveredModels(models: ClaudeModel[]): boolean {
  if (!models.length) return false;
  const changed = JSON.stringify(models) !== JSON.stringify(discovered);
  discovered = models;
  if (changed) writeCachedModels(models);
  return changed;
}

function modelCachePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "claude-zed-shim", "models.json");
}

function readCachedModels(): ClaudeModel[] | null {
  try {
    const parsed = JSON.parse(readFileSync(modelCachePath(), "utf8"));
    return Array.isArray(parsed) && parsed.length ? (parsed as ClaudeModel[]) : null;
  } catch {
    return null;
  }
}

function writeCachedModels(models: ClaudeModel[]): void {
  try {
    const file = modelCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(models, null, 2));
  } catch {
  }
}

export function isFastModelId(modelId: string): boolean {
  return getClaudeModels().find((m) => m.id === modelId)?.fast === true;
}

export function resolveClaudeModelId(modelId: string): string {
  const match = getClaudeModels().find((m) => m.id === modelId);
  if (!match) return modelId;
  return match.resolvedId || match.id;
}

export function buildEffortVariants(model: ClaudeModel): ClaudeEffort[] {
  if (!model.reasoning) return [];
  return model.efforts ? [...model.efforts] : [...EFFORT_LEVELS];
}

const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;
let lastModelRefresh = 0;

export async function refreshModelsFromCli(): Promise<boolean> {
  const now = Date.now();
  if (now - lastModelRefresh < MODEL_REFRESH_INTERVAL_MS) return false;
  lastModelRefresh = now;
  try {
    const rows = await listClaudeSupportedModels();
    if (!rows?.length) return false;
    return setDiscoveredModels(modelsFromSdk(rows as SdkModelRow[]));
  } catch {
    return false;
  }
}
