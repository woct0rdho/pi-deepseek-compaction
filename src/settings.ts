/**
 * Reader for Pi's own compaction settings. Pi remains the single owner of the
 * thresholds; this module only reads `reserveTokens` to derive the default
 * summarize output cap.
 * @module pi-deepseek-compaction/settings
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiCompactionSettings } from "./types.ts";

/** Pi's default response reserve, matching `DEFAULT_COMPACTION_SETTINGS`. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** Pi's default retained tail, reported by the status command. */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

type JsonRecord = Record<string, unknown>;

function readSettings(path: string): JsonRecord {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : undefined;
}

/**
 * Read Pi's compaction settings from the agent directory and, when the project
 * is trusted, the project `.pi` directory.
 * @param cwd - current working directory.
 * @param projectTrusted - whether project-local resources may be read.
 * @returns Pi's compaction settings with Pi's defaults applied.
 */
export function loadPiCompactionSettings(cwd: string, projectTrusted: boolean): PiCompactionSettings {
  const globalSettings = readSettings(join(getAgentDir(), "settings.json"));
  const projectSettings = projectTrusted ? readSettings(join(cwd, CONFIG_DIR_NAME, "settings.json")) : {};
  const globalCompaction = typeof globalSettings.compaction === "object" && globalSettings.compaction !== null
    ? (globalSettings.compaction as JsonRecord)
    : {};
  const projectCompaction = typeof projectSettings.compaction === "object" && projectSettings.compaction !== null
    ? (projectSettings.compaction as JsonRecord)
    : {};
  const merged = { ...globalCompaction, ...projectCompaction };

  return {
    enabled: merged.enabled !== false,
    reserveTokens: toFiniteNumber(merged.reserveTokens) ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: toFiniteNumber(merged.keepRecentTokens) ?? DEFAULT_KEEP_RECENT_TOKENS,
  };
}
