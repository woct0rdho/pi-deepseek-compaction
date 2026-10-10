// Shared types for the extension: resolved configuration, the compaction
// details recorded in the ordinary {@link https://pi.dev CompactionEntry}, and
// the process-local records used by the status command.

export type SummarizeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type NotifyPolicy = "off" | "summary" | "diagnostic";

export type CacheRetention = "none" | "short" | "long";

// Configured retention. `"inherit"` forwards nothing, so pi-ai applies exactly
// what a normal turn uses and the replayed prefix keeps identical cache markers.
export type ConfiguredCacheRetention = "inherit" | CacheRetention;

// Validated compaction settings from config files and environment overrides.
export interface CompactionConfig {
  // Model id for the summarize call. Empty selects the session model.
  model: string;
  // Thinking level for the summarize call. Empty selects the session level.
  thinkingLevel: SummarizeThinkingLevel | "";
  // Output cap. `0` selects `floor(0.8 * reserveTokens)` clamped by the model.
  maxTokens: number;
  cacheRetention: ConfiguredCacheRetention;
}

// Validated extension configuration.
export interface ResolvedConfig {
  compaction: CompactionConfig;
  // Append Pi's `<read-files>` / `<modified-files>` blocks to the summary.
  fileLists: boolean;
  notify: NotifyPolicy;
  // Build and report the request without calling the model.
  dryRun: boolean;
}

export interface ConfigResolution {
  config: ResolvedConfig;
  globalPath: string;
  projectPath: string;
  globalFound: boolean;
  projectFound: boolean;
  problems: string[];
}

// One compaction's cache accounting, stored under `details.dshCompaction`.
export interface PrefixCompactionDetails {
  version: 1;
  instructionVersion: number;
  // `provider/model` used for normal turns.
  modelKey: string;
  // `provider/model` resolved for the summarize call.
  summarizationModelKey: string;
  maxTokens: number;
  // Thinking level the extension resolved. With a captured request shape the
  // sent thinking mode is the replayed one, not necessarily this value.
  thinkingLevel: SummarizeThinkingLevel | null;
  cacheRetention: ConfiguredCacheRetention;
  // Whether a same-model capture of the last real request was available: the
  // summarize call replays that request's shape (thinking mode, tool choice,
  // tool schemas, provider extras) instead of rebuilding it from settings.
  replaySource?: "capture" | "none";
  // Replayed non-message payload fields, sorted. Messages and the output cap are
  // always the summarize call's own.
  replayFields?: string[];
  // Captured fields left out of the replay because replaying them would force a
  // tool call (for example `tool_choice: "required"`).
  replayAdjusted?: string[];
  // Messages replayed before the instruction.
  prefixMessages: number;
  // Heuristic price of the system prompt plus prefix messages.
  prefixTokens: number;
  // Provider-reported prompt size of the summarize call, when available.
  promptTokens?: number;
  // Leading messages shared with the last captured real request.
  sharedPrefixMessages: number;
  // Heuristic price of the shared leading messages.
  sharedPrefixTokens: number;
  cacheRead: number;
  cacheWrite: number;
  // Heuristic price of the summary text.
  summaryTokens: number;
  // Heuristic price of the messages the summary replaces.
  shadowedTokens: number;
  reason: "manual" | "threshold" | "overflow";
  customInstructionsUsed: boolean;
}

// Pi's own file lists, kept at the top level of the entry details.
export interface FileListDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

export type ExtensionCompactionDetails = FileListDetails & {
  dshCompaction: PrefixCompactionDetails;
};

export interface FailureRecord {
  at: number;
  reason: string;
}

// Pi's own compaction settings used to derive the default output cap.
export interface PiCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}
