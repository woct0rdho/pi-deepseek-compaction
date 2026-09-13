/**
 * Status command content: the effective configuration, the resolved models, and
 * the cache-read ratio of the last and of all compactions recorded by this
 * extension in the session. Numbers come from ordinary `CompactionEntry`
 * details, so they survive resume, fork, and tree navigation.
 * @module pi-deepseek-compaction/status
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  ConfigResolution,
  FailureRecord,
  PiCompactionSettings,
  PrefixCompactionDetails,
} from "./types.ts";

/** One compaction recorded by this extension. */
export interface PrefixCompactionRecord {
  entryId: string;
  timestamp: string;
  details: PrefixCompactionDetails;
}

/** Session-wide cache statistics over this extension's compactions. */
export interface RollingStats {
  /** Compactions recorded by this extension. */
  count: number;
  /** Compactions in the session that this extension did not produce. */
  otherCompactions: number;
  prefixTokens: number;
  sharedPrefixTokens: number;
  cacheRead: number;
  cacheWrite: number;
  last?: PrefixCompactionRecord;
}

function isPrefixDetails(value: unknown): value is PrefixCompactionDetails {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.prefixMessages === "number"
    && typeof record.prefixTokens === "number"
    && typeof record.cacheRead === "number";
}

function readPrefixDetails(entry: SessionEntry): PrefixCompactionDetails | undefined {
  if (entry.type !== "compaction") return undefined;
  const details = entry.details;
  if (typeof details !== "object" || details === null) return undefined;
  const nested = (details as Record<string, unknown>).dshCompaction;
  return isPrefixDetails(nested) ? nested : undefined;
}

/**
 * Sum this extension's recorded compactions and count the rest.
 * @param entries - every session entry, as Pi reports them.
 * @returns the rolling statistics shown by the status command.
 */
export function collectRollingStats(entries: readonly SessionEntry[]): RollingStats {
  const stats: RollingStats = {
    count: 0,
    otherCompactions: 0,
    prefixTokens: 0,
    sharedPrefixTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const entry of entries) {
    if (entry.type !== "compaction") continue;
    const details = readPrefixDetails(entry);
    if (details === undefined) {
      stats.otherCompactions += 1;
      continue;
    }
    stats.count += 1;
    stats.prefixTokens += details.prefixTokens;
    stats.sharedPrefixTokens += details.sharedPrefixTokens;
    stats.cacheRead += details.cacheRead;
    stats.cacheWrite += details.cacheWrite;
    stats.last = { entryId: entry.id, timestamp: entry.timestamp, details };
  }
  return stats;
}

/**
 * Render a ratio, or `n/a` when the denominator is zero.
 * @param numerator - measured part, such as cache-read tokens.
 * @param denominator - total part, such as estimated prefix tokens.
 * @returns the ratio with two decimals.
 */
export function formatRatio(numerator: number, denominator: number): string {
  if (denominator <= 0) return "n/a";
  return (numerator / denominator).toFixed(2);
}

/** Inputs for the status report text. */
export interface StatusReportParams {
  resolution: ConfigResolution;
  piSettings: PiCompactionSettings;
  sessionModelKey: string;
  summarizeModelKey: string;
  sameModel: boolean;
  stats: RollingStats;
  lastFailure: FailureRecord | undefined;
  problems: readonly string[];
}

/**
 * Build the status command's report.
 * @param params - configuration, models, rolling statistics, and known problems.
 * @returns the notification text.
 */
export function buildStatusReport(params: StatusReportParams): string {
  const { config } = params.resolution;
  const { stats } = params;
  const lines: string[] = [
    "deepseek-compaction: loaded (Pi-owned enablement; notify " + config.notify + ")",
    `Config: ${params.resolution.globalPath} (${params.resolution.globalFound ? "found" : "missing"})`
      + ` + ${params.resolution.projectPath} (${params.resolution.projectFound ? "found" : "missing"})`,
    `Effective: model=${config.compaction.model || "(session)"}`
      + ` thinkingLevel=${config.compaction.thinkingLevel || "(session)"}`
      + ` maxTokens=${config.compaction.maxTokens > 0 ? config.compaction.maxTokens : "0.8 x reserve"}`
      + ` cacheRetention=${config.compaction.cacheRetention}`
      + ` fileLists=${config.fileLists}`
      + ` dryRun=${config.dryRun}`,
    `Session model: ${params.sessionModelKey}`,
    `Summarize model: ${params.summarizeModelKey}`
      + (params.sameModel ? " (same model: prefix reuse expected)" : " (different model: prefix reuse not expected)"),
    `Pi settings: reserve ${params.piSettings.reserveTokens}, keepRecent ${params.piSettings.keepRecentTokens}`,
    `Compactions by this extension: ${stats.count} (other compactions skipped: ${stats.otherCompactions})`,
  ];
  if (stats.last !== undefined) {
    const details = stats.last.details;
    lines.push(
      `Last:    cacheRead ${details.cacheRead} / prefixTokens ${details.prefixTokens}`
        + ` = ${formatRatio(details.cacheRead, details.prefixTokens)}`
        + `   prefix fidelity ${details.sharedPrefixMessages}/${details.prefixMessages} messages`
        + `   (${details.reason}, ${details.modelKey})`,
    );
  } else {
    lines.push("Last:    none recorded by this extension");
  }
  lines.push(
    `Rolling: cacheRead ${stats.cacheRead} / prefixTokens ${stats.prefixTokens}`
      + ` = ${formatRatio(stats.cacheRead, stats.prefixTokens)}`,
  );
  lines.push(
    params.lastFailure === undefined
      ? "Last failure: none"
      : `Last failure: ${new Date(params.lastFailure.at).toISOString()} ${params.lastFailure.reason}`,
  );
  const problems = [...params.resolution.problems, ...params.problems];
  if (problems.length > 0) {
    lines.push("Configuration problems:");
    for (const problem of problems) lines.push(`- ${problem}`);
  }
  return lines.join("\n");
}
