/**
 * The summarize call itself and the checks that keep a bad summary out of the
 * session: non-empty text, no tool calls, no truncated generation, and a
 * replacement strictly smaller than the span it replaces.
 * @module pi-deepseek-compaction/summarize
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Message, Model, ThinkingLevel, Tool, Usage } from "@earendil-works/pi-ai";
import { framedSummaryText } from "./instruction.ts";
import { priceText } from "./prefix.ts";
import type { CacheRetention } from "./types.ts";

/** A summary that must not be landed in the session. */
export class SummarizeError extends Error {
  override readonly name = "SummarizeError";
}

/** Everything one summarize request needs. */
export interface SummarizeCall {
  model: Model<any>;
  systemPrompt: string;
  /** Replayed prefix followed by the instruction message. */
  messages: Message[];
  tools: Tool[];
  maxTokens: number;
  reasoning: ThinkingLevel | undefined;
  cacheRetention: CacheRetention;
  apiKey: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Completion function, injectable so tests never reach a provider. */
export type CompleteFunction = typeof completeSimple;

/** Accepted summary text and the usage of the call that produced it. */
export interface SummarizeOutcome {
  summary: string;
  usage?: Usage;
}

/** Join the text blocks of one assistant message. */
function textOf(message: AssistantMessage): string {
  return message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

/**
 * Reject a response that cannot become a checkpoint.
 * @param response - assistant message returned by the provider adapter.
 * @returns the summary text.
 * @throws {SummarizeError} on provider errors, truncation, tool calls, or empty text.
 */
export function validateSummaryResponse(response: AssistantMessage): string {
  if (response.stopReason === "error") {
    throw new SummarizeError(`summarization failed: ${response.errorMessage ?? "unknown provider error"}`);
  }
  if (response.stopReason === "aborted") {
    throw new SummarizeError("summarization was aborted");
  }
  if (response.stopReason === "length") {
    throw new SummarizeError("summarization hit the output cap and the checkpoint is incomplete");
  }
  if (response.content.some(block => block.type === "toolCall")) {
    throw new SummarizeError("summarization attempted to call a tool");
  }
  const summary = textOf(response);
  if (summary.length === 0) {
    throw new SummarizeError("summarization produced no text");
  }
  return summary;
}

/**
 * Require the replacement to be smaller than the content it replaces.
 * @param summary - validated summary text.
 * @param shadowedTokens - heuristic price of the messages being replaced.
 * @returns the summary price and the framed replacement price.
 * @throws {SummarizeError} when the framed summary is not smaller.
 */
export function assertSummaryShrinks(
  summary: string,
  shadowedTokens: number,
): { summaryTokens: number; replacementTokens: number } {
  const summaryTokens = priceText(summary);
  const replacementTokens = priceText(framedSummaryText(summary));
  if (replacementTokens >= shadowedTokens) {
    throw new SummarizeError(
      `summary is not smaller than the replaced history (${replacementTokens} >= ${shadowedTokens} estimated tokens)`,
    );
  }
  return { summaryTokens, replacementTokens };
}

/**
 * Run the summarize request through the same provider adapter a normal turn uses.
 * @param call - model, replayed prefix, instruction, and call options.
 * @param complete - completion function; defaults to pi-ai's `completeSimple`.
 * @returns accepted summary text and provider usage.
 * @throws {SummarizeError} when the response cannot become a checkpoint.
 */
export async function runSummarizeCall(
  call: SummarizeCall,
  complete: CompleteFunction = completeSimple,
): Promise<SummarizeOutcome> {
  const response = await complete(
    call.model,
    {
      systemPrompt: call.systemPrompt,
      messages: call.messages,
      tools: call.tools,
    },
    {
      apiKey: call.apiKey,
      ...(call.headers === undefined ? {} : { headers: call.headers }),
      maxTokens: call.maxTokens,
      cacheRetention: call.cacheRetention,
      toolChoice: "none",
      ...(call.reasoning === undefined ? {} : { reasoning: call.reasoning }),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    },
  );
  const summary = validateSummaryResponse(response);
  return { summary, usage: response.usage };
}
