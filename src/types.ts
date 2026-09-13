/**
 * Shared types for the extension: resolved configuration, the compaction
 * details recorded in the ordinary {@link https://pi.dev CompactionEntry}, and
 * the process-local records used by the status command.
 * @module pi-deepseek-compaction/types
 */

/** Thinking level accepted by `compaction.thinkingLevel`, including an explicit off. */
export type SummarizeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Notification policy for successful compactions. Failures always notify. */
export type NotifyPolicy = "off" | "summary" | "diagnostic";

/** Cache retention preference forwarded to pi-ai for the summarize call. */
export type CacheRetention = "none" | "short" | "long";

/** Validated compaction settings from config files and environment overrides. */
export interface CompactionConfig {
  /** Model id for the summarize call; empty selects the session model. */
  model: string;
  /** Thinking level for the summarize call; empty selects the session level. */
  thinkingLevel: SummarizeThinkingLevel | "";
  /** Output cap; `0` selects `floor(0.8 * reserveTokens)` clamped by the model. */
  maxTokens: number;
  cacheRetention: CacheRetention;
}

/** Validated extension configuration. */
export interface ResolvedConfig {
  compaction: CompactionConfig;
  /** Append Pi's `<read-files>` / `<modified-files>` blocks to the summary. */
  fileLists: boolean;
  notify: NotifyPolicy;
  /** Build and report the request without calling the model. */
  dryRun: boolean;
}

/** Configuration, the files it came from, and every value that was rejected. */
export interface ConfigResolution {
  config: ResolvedConfig;
  globalPath: string;
  projectPath: string;
  globalFound: boolean;
  projectFound: boolean;
  problems: string[];
}

/** One compaction's cache accounting, stored under `details.dshCompaction`. */
export interface PrefixCompactionDetails {
  version: 1;
  instructionVersion: number;
  /** `provider/model` used for normal turns. */
  modelKey: string;
  /** `provider/model` resolved for the summarize call. */
  summarizationModelKey: string;
  maxTokens: number;
  /** Thinking level sent, or null when the call ran without thinking. */
  thinkingLevel: SummarizeThinkingLevel | null;
  cacheRetention: CacheRetention;
  /** Messages replayed before the instruction. */
  prefixMessages: number;
  /** Heuristic price of the system prompt plus prefix messages. */
  prefixTokens: number;
  /** Provider-reported prompt size of the summarize call, when available. */
  promptTokens?: number;
  /** Leading messages shared with the last captured real request. */
  sharedPrefixMessages: number;
  /** Heuristic price of the shared leading messages. */
  sharedPrefixTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Heuristic price of the summary text. */
  summaryTokens: number;
  /** Heuristic price of the messages the summary replaces. */
  shadowedTokens: number;
  reason: "manual" | "threshold" | "overflow";
  customInstructionsUsed: boolean;
}

/** Pi's own file lists, kept at the top level of the entry details. */
export interface FileListDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

/** Details payload written by this extension. */
export type ExtensionCompactionDetails = FileListDetails & {
  dshCompaction: PrefixCompactionDetails;
};

/** Failure shown by the status command; process-local and never persisted. */
export interface FailureRecord {
  at: number;
  reason: string;
}

/** Pi's own compaction settings used to derive the default output cap. */
export interface PiCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}
