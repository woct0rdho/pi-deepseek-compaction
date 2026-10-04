// Entry point for the prefix-preserving compaction extension. Pi keeps its own
// trigger policy, `CompactionEntry`, `firstKeptEntryId`, and `/compact`; this
// extension only replaces how the summary text is produced: it replays Pi's own
// session projection up to the compaction cut and appends one instruction
// message. Because the projection is what a normal request sends, the provider
// adapter derives the same system prompt, tool declarations, and leading
// messages, so the request keeps a byte-identical prefix and the provider's
// prompt cache serves it. Every failure cancels the compaction, so Pi's
// built-in compactor is never invoked.

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
  fingerprintMessages,
  priceMessages,
  sharedPrefixMessageCount,
  sliceProjection,
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
import { assertSummaryShrinks, runSummarizeCall, type CompleteFunction } from "./summarize.ts";
import type { ExtensionCompactionDetails, FailureRecord } from "./types.ts";

export const STATUS_COMMAND = "deepseek-compaction";

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
      // The UI is optional and can be torn down mid-session. Fall through to
      // stderr rather than failing a compaction for a diagnostic.
      void error;
    }
  }
  // Print and JSON modes have no dialog-capable UI, so the same text goes to
  // stderr where it cannot corrupt a machine-readable stdout stream.
  process.stderr.write(`[deepseek-compaction] ${text}\n`);
}

export default function piDeepseekCompaction(pi: ExtensionAPI, options: PrefixCompactionOptions = {}): void {
  const captures = new RequestCaptureStore();
  const failures = new Map<string, FailureRecord>();
  const reportedProblems = new Set<string>();

  const sessionIdOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
  const sessionModelKey = (ctx: ExtensionContext): string =>
    ctx.model === undefined ? "none" : modelKey(ctx.model);

  pi.on("context_with_system", (event, ctx) => {
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
        event.preparation.settings.reserveTokens,
        model.maxTokens,
      );

      const slice = sliceProjection(
        ctx.sessionManager.buildSessionProjection(),
        event.preparation.firstKeptEntryId,
      );
      const prefixTokens = priceMessages(slice.messages);
      const shadowedTokens = priceMessages(slice.summarized);
      const captured = captures.get(id);
      const sharedPrefixMessages = sharedPrefixMessageCount(
        captured?.messageHashes,
        fingerprintMessages(slice.messages),
      );
      const sharedPrefixTokens = priceMessages(slice.messages.slice(0, sharedPrefixMessages));

      if (config.dryRun) {
        return cancel(
          `dry run: would summarize ${slice.summarized.length} conversation messages`
            + ` (~${shadowedTokens} tokens; ${slice.messages.length} projected messages, ~${prefixTokens} tokens;`
            + ` ${sharedPrefixMessages} shared with ${captured?.modelKey ?? "no"} capture)`
            + ` as ${modelKey(model)} with maxTokens ${maxTokens}`
            + ` and cacheRetention ${config.compaction.cacheRetention}`,
          true,
          "info",
        );
      }

      // Pi's own provider stack: request-time auth, transport, and adapter.
      const hostComplete: CompleteFunction = (callModel, callContext, callOptions) =>
        ctx.modelRegistry.streamSimple(callModel, callContext, callOptions).result();

      const outcome = await runSummarizeCall(
        {
          model,
          context: {
            messages: [...toLlmMessages(slice.messages), buildInstructionMessage(event.customInstructions)],
          },
          maxTokens,
          reasoning,
          cacheRetention:
            config.compaction.cacheRetention === "inherit" ? undefined : config.compaction.cacheRetention,
          sessionId: id,
          signal: event.signal,
        },
        options.complete ?? hostComplete,
      );
      const { summaryTokens } = assertSummaryShrinks(outcome.summary, shadowedTokens);

      const ops = createFileOps();
      if (config.fileLists) {
        collectPreviousFileOps(event.branchEntries, ops);
        extractFileOpsFromMessages(slice.summarized, ops);
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
          prefixMessages: slice.messages.length,
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
        const base = `deepseek-compaction: compacted ${slice.summarized.length} messages`
          + `; cacheRead ${usage?.cacheRead ?? 0}/${prefixTokens} = ${formatRatio(usage?.cacheRead ?? 0, prefixTokens)}`;
        const text = config.notify === "diagnostic"
          ? `${base}; prefix fidelity ${sharedPrefixMessages}/${slice.messages.length}`
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
      const settings = loadPiCompactionSettings(pi.getSettings());
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
