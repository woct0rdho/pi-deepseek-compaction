/**
 * Configuration loading. The global file `~/.pi/agent/deepseek-compaction.json`
 * and the project file `<cwd>/.pi/deepseek-compaction.json` are read
 * tolerantly, environment variables override both, and no failure ever throws:
 * a malformed file behaves like a missing one, an invalid value falls back to
 * its default, and the rejection is recorded for the status command.
 * @module pi-deepseek-compaction/config
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  CacheRetention,
  CompactionConfig,
  ConfigResolution,
  NotifyPolicy,
  ResolvedConfig,
  SummarizeThinkingLevel,
} from "./types.ts";

/** File name used in the agent directory and in a project `.pi` directory. */
export const CONFIG_FILE_NAME = "deepseek-compaction.json";

/** Environment prefix for every override. */
export const ENV_PREFIX = "PI_DEEPSEEK_COMPACTION_";

/** Thinking levels accepted from configuration, including an explicit off. */
export const THINKING_LEVELS: readonly SummarizeThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Cache retention values accepted from configuration. */
export const CACHE_RETENTION_VALUES: readonly CacheRetention[] = ["none", "short", "long"];

/** Notification policies accepted from configuration. */
export const NOTIFY_POLICIES: readonly NotifyPolicy[] = ["off", "summary", "diagnostic"];

const DEFAULT_COMPACTION: CompactionConfig = {
  model: "",
  thinkingLevel: "",
  maxTokens: 0,
  cacheRetention: "none",
};

const DEFAULT_CONFIG: ResolvedConfig = {
  compaction: DEFAULT_COMPACTION,
  fileLists: true,
  notify: "off",
  dryRun: false,
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read one JSON object, treating a missing, malformed, or non-object file as absent. */
function readJsonRecord(path: string): { found: boolean; value: JsonRecord } {
  if (!existsSync(path)) return { found: false, value: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? { found: true, value: parsed } : { found: false, value: {} };
  } catch {
    return { found: false, value: {} };
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function toMember<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const text = nonEmptyString(value)?.toLowerCase();
  if (text === undefined) return undefined;
  return (allowed as readonly string[]).includes(text) ? (text as T) : undefined;
}

/** Accept an optional string, where an empty value means "use the session default". */
function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim();
}

/** Accept a choice that may be explicitly cleared with an empty string. */
function toOptionalMember<T extends string>(value: unknown, allowed: readonly T[]): T | "" | undefined {
  const text = toOptionalString(value);
  if (text === undefined) return undefined;
  if (text.length === 0) return "";
  return toMember(text, allowed);
}

interface Layer {
  source: string;
  value: unknown;
}

/**
 * Return the first defined layer's coerced value, recording one problem when
 * that value is present but invalid.
 */
function resolveField<T>(
  layers: readonly Layer[],
  coerce: (value: unknown) => T | undefined,
  fallback: T,
  problems: string[],
): T {
  for (const layer of layers) {
    if (layer.value === undefined) continue;
    const coerced = coerce(layer.value);
    if (coerced !== undefined) return coerced;
    problems.push(`${layer.source}: invalid value ${JSON.stringify(layer.value)}; using ${JSON.stringify(fallback)}`);
    return fallback;
  }
  return fallback;
}

/**
 * Resolve the extension configuration for one working directory.
 * @param cwd - working directory whose `.pi` directory may hold a project config.
 * @param env - environment source, injectable for tests.
 * @returns the resolved configuration, the files it read, and rejected values.
 */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfigResolution {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || getAgentDir();
  const globalPath = join(agentDir, CONFIG_FILE_NAME);
  const projectPath = join(cwd, ".pi", CONFIG_FILE_NAME);
  const globalFile = readJsonRecord(globalPath);
  const projectFile = readJsonRecord(projectPath);
  const problems: string[] = [];

  const globalCompaction = isRecord(globalFile.value.compaction) ? globalFile.value.compaction : {};
  const projectCompaction = isRecord(projectFile.value.compaction) ? projectFile.value.compaction : {};

  const envValue = (name: string): unknown => {
    const value = env[`${ENV_PREFIX}${name}`];
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  const layer = (envName: string, key: string, compaction = false): Layer[] => [
    { source: `environment ${ENV_PREFIX}${envName}`, value: envValue(envName) },
    { source: projectPath, value: compaction ? projectCompaction[key] : projectFile.value[key] },
    { source: globalPath, value: compaction ? globalCompaction[key] : globalFile.value[key] },
  ];

  const compaction: CompactionConfig = {
    model:
      resolveField(layer("MODEL", "model", true), toOptionalString, DEFAULT_COMPACTION.model, problems),
    thinkingLevel: resolveField(
      layer("THINKING_LEVEL", "thinkingLevel", true),
      value => toOptionalMember(value, THINKING_LEVELS),
      DEFAULT_COMPACTION.thinkingLevel,
      problems,
    ),
    maxTokens: resolveField(
      layer("MAX_TOKENS", "maxTokens", true),
      toPositiveInteger,
      DEFAULT_COMPACTION.maxTokens,
      problems,
    ),
    cacheRetention: resolveField(
      layer("CACHE_RETENTION", "cacheRetention", true),
      value => toMember(value, CACHE_RETENTION_VALUES),
      DEFAULT_COMPACTION.cacheRetention,
      problems,
    ),
  };

  const config: ResolvedConfig = {
    compaction,
    fileLists: resolveField(layer("FILE_LISTS", "fileLists"), toBoolean, DEFAULT_CONFIG.fileLists, problems),
    notify: resolveField(
      layer("NOTIFY", "notify"),
      value => toMember(value, NOTIFY_POLICIES),
      DEFAULT_CONFIG.notify,
      problems,
    ),
    dryRun: resolveField(layer("DRYRUN", "dryRun"), toBoolean, DEFAULT_CONFIG.dryRun, problems),
  };

  return {
    config,
    globalPath,
    projectPath,
    globalFound: globalFile.found,
    projectFound: projectFile.found,
    problems,
  };
}
