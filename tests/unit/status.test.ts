/**
 * Unit tests for the rolling cache statistics and the status report.
 * @module pi-deepseek-compaction/tests/unit/status
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.ts";
import { buildStatusReport, collectRollingStats, formatRatio } from "../../src/status.ts";
import type { PrefixCompactionDetails } from "../../src/types.ts";

function compactionEntry(id: string, details: unknown, timestamp = new Date(0).toISOString()): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp,
    summary: "s",
    firstKeptEntryId: "x",
    tokensBefore: 1,
    details,
  } as SessionEntry;
}

function details(overrides: Partial<PrefixCompactionDetails> = {}): PrefixCompactionDetails {
  return {
    version: 1,
    instructionVersion: 1,
    modelKey: "deepseek/deepseek-v4-pro",
    summarizationModelKey: "deepseek/deepseek-v4-pro",
    maxTokens: 8192,
    thinkingLevel: null,
    cacheRetention: "none",
    prefixMessages: 12,
    prefixTokens: 10_000,
    sharedPrefixMessages: 12,
    sharedPrefixTokens: 10_000,
    cacheRead: 9_000,
    cacheWrite: 0,
    summaryTokens: 300,
    shadowedTokens: 10_000,
    reason: "threshold",
    customInstructionsUsed: false,
    ...overrides,
  };
}

describe("collectRollingStats", () => {
  it("accumulates this extension's compactions and counts the others", () => {
    const stats = collectRollingStats([
      compactionEntry("c1", { dshCompaction: details({ cacheRead: 8_000, prefixTokens: 10_000 }) }),
      compactionEntry("c2", { readFiles: [], modifiedFiles: [] }),
      compactionEntry("c3", { dshCompaction: details({ cacheRead: 6_000, prefixTokens: 8_000 }) }),
    ]);
    assert.equal(stats.count, 2);
    assert.equal(stats.otherCompactions, 1);
    assert.equal(stats.cacheRead, 14_000);
    assert.equal(stats.prefixTokens, 18_000);
    assert.equal(stats.last?.entryId, "c3");
    assert.equal(formatRatio(stats.cacheRead, stats.prefixTokens), "0.78");
  });

  it("reports empty statistics for a session with no compactions", () => {
    const stats = collectRollingStats([]);
    assert.deepEqual(stats, {
      count: 0,
      otherCompactions: 0,
      prefixTokens: 0,
      sharedPrefixTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(formatRatio(0, 0), "n/a");
  });

  it("ignores malformed details", () => {
    const stats = collectRollingStats([
      compactionEntry("c1", { dshCompaction: { version: 2 } }),
      compactionEntry("c2", "nonsense"),
    ]);
    assert.equal(stats.count, 0);
    assert.equal(stats.otherCompactions, 2);
  });
});

describe("buildStatusReport", () => {
  const resolution = loadConfig("/nonexistent-working-directory", { PI_CODING_AGENT_DIR: "/nonexistent-agent-dir" });

  it("includes models, thresholds, and both ratios", () => {
    const report = buildStatusReport({
      resolution,
      piSettings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      sessionModelKey: "deepseek/deepseek-v4-pro",
      summarizeModelKey: "deepseek/deepseek-v4-pro",
      sameModel: true,
      stats: collectRollingStats([
        compactionEntry("c1", { dshCompaction: details({ cacheRead: 4_500, prefixTokens: 5_000 }) }),
      ]),
      lastFailure: undefined,
      problems: [],
    });
    assert.match(report, /session model: deepseek\/deepseek-v4-pro/i);
    assert.match(report, /same model: prefix reuse expected/);
    assert.match(report, /reserve 16384, keepRecent 20000/);
    assert.match(report, /Compactions by this extension: 1/);
    assert.match(report, /Last: {4}cacheRead 4500 \/ prefixTokens 5000 = 0.90/);
    assert.match(report, /prefix fidelity 12\/12 messages/);
    assert.match(report, /Rolling: cacheRead 4500 \/ prefixTokens 5000 = 0.90/);
    assert.match(report, /Last failure: none/);
  });

  it("notes a different summarization model, failures, and problems", () => {
    const report = buildStatusReport({
      resolution: { ...resolution, problems: ["config: invalid value"] },
      piSettings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      sessionModelKey: "deepseek/deepseek-v4-pro",
      summarizeModelKey: "deepseek/deepseek-flash",
      sameModel: false,
      stats: collectRollingStats([]),
      lastFailure: { at: Date.UTC(2026, 0, 2), reason: "compaction cancelled: prefix build failed" },
      problems: ["no credentials"],
    });
    assert.match(report, /different model: prefix reuse not expected/);
    assert.match(report, /Last: {4}none recorded/);
    assert.match(report, /Last failure: 2026-01-02T00:00:00.000Z compaction cancelled/);
    assert.match(report, /Configuration problems:/);
    assert.match(report, /- config: invalid value/);
    assert.match(report, /- no credentials/);
  });
});
