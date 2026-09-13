/**
 * Entry point for the prefix-preserving compaction extension. Pi keeps its own
 * trigger policy, `CompactionEntry`, `firstKeptEntryId`, and `/compact`; this
 * extension only replaces how the summary text is produced, by replaying a
 * byte-identical prefix of a real request and appending one instruction
 * message at the end. Every failure cancels the compaction, so Pi's built-in
 * compactor is never invoked.
 * @module pi-deepseek-compaction
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RequestCaptureStore } from "./capture.ts";
import { loadConfig } from "./config.ts";
import {
  collectPreviousFileOps,
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessages,
  formatFileOperations,
} from "./fileops.ts";
import { INSTRUCTION_VERSION, buildInstructionMessage } from "./instruction.ts";
import {
  buildPrefixMessages,
  collectActiveTools,
  fingerprintMessages,
  priceMessages,
  priceText,
  sharedPrefixMessageCount,
  toLlmMessages,
} from "./prefix.ts";
import {
  ConfigProblem,
  modelKey,
  resolveMaxTokens,
  resolveSummarizationModel,
  resolveThinkingLevel,
} from "./resolve.ts";
import { loadPiCompactionSettings } from "./settings.ts";
import { buildStatusReport, collectRollingStats, formatRatio } from "./status.ts";
import {
  assertSummaryShrinks,
  runSummarizeCall,
  type CompleteFunction,
} from "./summarize.ts";
import type { ExtensionCompactionDetails, FailureRecord } from "./types.ts";

/** Status command name registered for the interactive and RPC modes. */
export const STATUS_COMMAND = "deepseek-compaction";

/** Injectable dependencies; tests override the provider call. */
export interface PrefixCompactionOptions {
  complete?: CompleteFunction;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeNotify(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(text, level);
      return;
    } catch (error: unknown) {
      // The UI is optional and can be torn down mid-session; fall through to
      // stderr rather than failing a compaction for a diagnostic.
      void error;
    }
  }
  // Print and JSON modes have no dialog-capable UI, so the same text goes to
  // stderr where it cannot corrupt a machine-readable stdout stream.
  process.stderr.write(`[deepseek-compaction] ${text}\n`);
}

function safeProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

/** Keep only string-valued headers; providers may carry null deletions. */
function stringHeaders(headers: unknown): Record<string, string> | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") result[name] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * Register the extension: read-only request capture, the compaction hook, and
 * the status command.
 * @param pi - Pi's extension API.
 * @param options - injectable provider call used by tests.
 */
export default function piDeepseekCompaction(pi: ExtensionAPI, options: PrefixCompactionOptions = {}): void {
  const captures = new RequestCaptureStore();
  const failures = new Map<string, FailureRecord>();
  const reportedProblems = new Set<string>();

  const sessionIdOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
  const sessionModelKey = (ctx: ExtensionContext): string =>
    ctx.model === undefined ? "none" : modelKey(ctx.model);

  pi.on("context", (event, ctx) => {
    captures.capture(sessionIdOf(ctx), sessionModelKey(ctx), event.messages);
  });

  pi.on("session_start", (_event, ctx) => {
    const id = sessionIdOf(ctx);
    captures.clear(id);
    failures.delete(id);
  });

  const clearCapture = (_event: unknown, ctx: ExtensionContext): void => {
    captures.clear(sessionIdOf(ctx));
  };
  pi.on("session_before_switch", clearCapture);
  pi.on("session_before_fork", clearCapture);
  pi.on("session_before_tree", clearCapture);
  pi.on("session_shutdown", () => {
    captures.clearAll();
    failures.clear();
    reportedProblems.clear();
  });
  pi.on("session_compact", (_event, ctx) => {
    failures.delete(sessionIdOf(ctx));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const id = sessionIdOf(ctx);
    const resolution = loadConfig(ctx.cwd);
    const { config } = resolution;

    const cancel = (reason: string, report: boolean, level: "warning" | "info" = "warning") => {
      if (!event.signal.aborted) {
        failures.set(id, { at: Date.now(), reason });
        if (report) safeNotify(ctx, `deepseek-compaction: ${reason}`, level);
      }
      return { cancel: true as const };
    };

    try {
      const settings = loadPiCompactionSettings(ctx.cwd, safeProjectTrusted(ctx));
      const sessionModel = ctx.model;
      const model = resolveSummarizationModel(
        config.compaction.model,
        sessionModel,
        (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
      );
      const reasoning = resolveThinkingLevel(
        config.compaction.thinkingLevel,
        pi.getThinkingLevel(),
        model,
      );
      const maxTokens = resolveMaxTokens(
        config.compaction.maxTokens,
        settings.reserveTokens,
        model.maxTokens,
      );

      const systemPrompt = ctx.getSystemPrompt();
      const prefixMessages = buildPrefixMessages(event.branchEntries, event.preparation.firstKeptEntryId);
      const tools = collectActiveTools(pi);
      const instruction = buildInstructionMessage(event.customInstructions);
      const shadowedTokens = priceMessages(prefixMessages);
      const prefixTokens = priceText(systemPrompt) + shadowedTokens;
      const captured = captures.get(id);
      const sharedPrefixMessages = sharedPrefixMessageCount(
        captured?.messageHashes,
        fingerprintMessages(prefixMessages),
      );
      const sharedPrefixTokens = priceMessages(prefixMessages.slice(0, sharedPrefixMessages));

      if (config.dryRun) {
        return cancel(
          `dry run: would summarize ${prefixMessages.length} messages`
            + ` (~${shadowedTokens} tokens, ${sharedPrefixMessages} shared with ${captured?.modelKey ?? "no"} capture)`
            + ` as ${modelKey(model)} with maxTokens ${maxTokens}`
            + ` and cacheRetention ${config.compaction.cacheRetention}`,
          true,
          "info",
        );
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new ConfigProblem(`no credentials for ${modelKey(model)}: ${auth.error}`);
      }
      if (auth.apiKey === undefined || auth.apiKey.length === 0) {
        throw new ConfigProblem(`no API key resolved for ${modelKey(model)}`);
      }

      const outcome = await runSummarizeCall(
        {
          model,
          systemPrompt,
          messages: [...toLlmMessages(prefixMessages), instruction],
          tools,
          maxTokens,
          reasoning,
          cacheRetention: config.compaction.cacheRetention,
          apiKey: auth.apiKey,
          ...(stringHeaders(auth.headers) === undefined ? {} : { headers: stringHeaders(auth.headers) }),
          ...(auth.env === undefined ? {} : { env: auth.env }),
          signal: event.signal,
        },
        options.complete,
      );
      const { summaryTokens } = assertSummaryShrinks(outcome.summary, shadowedTokens);

      const ops = createFileOps();
      if (config.fileLists) {
        collectPreviousFileOps(event.branchEntries, ops);
        extractFileOpsFromMessages(prefixMessages, ops);
      }
      const lists = computeFileLists(ops);
      const summary = config.fileLists
        ? outcome.summary + formatFileOperations(lists)
        : outcome.summary;

      const usage = outcome.usage;
      const promptTokens = usage === undefined
        ? undefined
        : usage.input + usage.cacheRead + usage.cacheWrite;
      const details: ExtensionCompactionDetails = {
        readFiles: lists.readFiles,
        modifiedFiles: lists.modifiedFiles,
        dshCompaction: {
          version: 1,
          instructionVersion: INSTRUCTION_VERSION,
          modelKey: sessionModel === undefined ? "none" : modelKey(sessionModel),
          summarizationModelKey: modelKey(model),
          maxTokens,
          thinkingLevel: reasoning ?? null,
          cacheRetention: config.compaction.cacheRetention,
          prefixMessages: prefixMessages.length,
          prefixTokens,
          ...(promptTokens === undefined ? {} : { promptTokens }),
          sharedPrefixMessages,
          sharedPrefixTokens,
          cacheRead: usage?.cacheRead ?? 0,
          cacheWrite: usage?.cacheWrite ?? 0,
          summaryTokens,
          shadowedTokens,
          reason: event.reason,
          customInstructionsUsed:
            event.customInstructions !== undefined && event.customInstructions.trim().length > 0,
        },
      };

      if (config.notify !== "off") {
        const base = `deepseek-compaction: compacted ${prefixMessages.length} messages`
          + `; cacheRead ${usage?.cacheRead ?? 0}/${prefixTokens} = ${formatRatio(usage?.cacheRead ?? 0, prefixTokens)}`;
        const text = config.notify === "diagnostic"
          ? `${base}; prefix fidelity ${sharedPrefixMessages}/${prefixMessages.length}`
            + `; prompt tokens ${promptTokens ?? "n/a"}; model ${modelKey(model)}`
          : base;
        safeNotify(ctx, text, "info");
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          ...(usage === undefined ? {} : { usage }),
          details,
        },
      };
    } catch (error: unknown) {
      if (event.signal.aborted) return cancel("compaction cancelled", false);
      if (error instanceof ConfigProblem) {
        const key = `${id}|${error.message}`;
        const firstReport = !reportedProblems.has(key);
        if (firstReport) reportedProblems.add(key);
        return cancel(`cannot summarize: ${error.message}`, firstReport);
      }
      return cancel(`compaction cancelled: ${errorMessage(error)}`, true);
    }
  });

  pi.registerCommand(STATUS_COMMAND, {
    description: "Show prefix-preserving compaction status and cache statistics",
    handler: async (_args, ctx) => {
      const id = sessionIdOf(ctx);
      const resolution = loadConfig(ctx.cwd);
      const settings = loadPiCompactionSettings(ctx.cwd, safeProjectTrusted(ctx));
      const sessionModel = ctx.model;
      const problems: string[] = [...resolution.problems];
      let summarizeModelKey = "unresolved";
      let sameModel = false;
      try {
        const model = resolveSummarizationModel(
          resolution.config.compaction.model,
          sessionModel,
          (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
        );
        resolveThinkingLevel(resolution.config.compaction.thinkingLevel, pi.getThinkingLevel(), model);
        summarizeModelKey = modelKey(model);
        sameModel = sessionModel !== undefined && modelKey(model) === modelKey(sessionModel);
      } catch (error: unknown) {
        problems.push(errorMessage(error));
      }
      const report = buildStatusReport({
        resolution,
        piSettings: settings,
        sessionModelKey: sessionModelKey(ctx),
        summarizeModelKey,
        sameModel,
        stats: collectRollingStats(ctx.sessionManager.getEntries()),
        lastFailure: failures.get(id),
        problems,
      });
      safeNotify(ctx, report, "info");
    },
  });
}
