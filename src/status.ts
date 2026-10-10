// Status command content: the effective configuration, the resolved models, and
// the cache-read ratio of the last and of all compactions recorded by this
// extension in the session. Numbers come from ordinary `CompactionEntry`
// details, so they survive resume, fork, and tree navigation.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  ConfigResolution,
  FailureRecord,
  PiCompactionSettings,
  PrefixCompactionDetails,
} from "./types.ts";

export interface PrefixCompactionRecord {
  entryId: string;
  timestamp: string;
  details: PrefixCompactionDetails;
}

// Session-wide cache statistics over this extension's compactions.
export interface RollingStats {
  // Compactions recorded by this extension.
  count: number;
  // Compactions in the session that this extension did not produce.
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

export function formatRatio(numerator: number, denominator: number): string {
  if (denominator <= 0) return "n/a";
  return (numerator / denominator).toFixed(2);
}

export interface StatusReportParams {
  resolution: ConfigResolution;
  piSettings: PiCompactionSettings;
  sessionModelKey: string;
  summarizeModelKey: string;
  sameModel: boolean;
  // The last real request Pi sent, as observed by this session's capture.
  capture: CapturedRequestSummary | undefined;
  stats: RollingStats;
  lastFailure: FailureRecord | undefined;
  problems: readonly string[];
}

// What the summarize call will replay: the shape of the last real request.
export interface CapturedRequestSummary {
  ageMs: number;
  modelKey: string;
  // Messages of the last real request, and its replayed field count.
  messageCount: number;
  replayFieldCount: number;
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

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
    params.capture === undefined
      ? "Replay source: no real request captured yet (the shape is built from settings)"
      : `Replay source: last real request ${formatAge(params.capture.ageMs)} ago`
        + ` (${params.capture.modelKey}, ${params.capture.messageCount} messages,`
        + ` ${params.capture.replayFieldCount} non-message fields to replay)`,
    `Pi settings: reserve ${params.piSettings.reserveTokens}, keepRecent ${params.piSettings.keepRecentTokens}`,
    `Compactions by this extension: ${stats.count} (other compactions skipped: ${stats.otherCompactions})`,
  ];
  if (stats.last !== undefined) {
    const details = stats.last.details;
    lines.push(
      `Last:    cacheRead ${details.cacheRead} / prefixTokens ${details.prefixTokens}`
        + ` = ${formatRatio(details.cacheRead, details.prefixTokens)}`
        + `   prefix fidelity ${details.sharedPrefixMessages}/${details.prefixMessages} messages`
        + (details.replayFields === undefined
          ? "   shape built from settings"
          : `   shape replayed (${details.replayFields.length} fields)`)
        + (details.replayAdjusted === undefined
          ? ""
          : `, dropped ${details.replayAdjusted.join(", ")}`)
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
