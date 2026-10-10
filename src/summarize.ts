// The summarize call itself and the checks that keep a bad summary out of the
// session: non-empty text, no tool calls, no truncated generation, and a
// replacement strictly smaller than the span it replaces.

import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import { framedSummaryText } from "./instruction.ts";
import { priceText } from "./prefix.ts";
import { mergeReplayPayload, type ReplayFields } from "./replay.ts";
import type { CacheRetention } from "./types.ts";

export class SummarizeError extends Error {
  override readonly name = "SummarizeError";
}

// Completion function used to run the request. The host supplies the provider
// stack and request-time authentication, so the extension never handles
// credentials or provider payloads itself.
export type CompleteFunction = (
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

// Everything one summarize request needs.
export interface SummarizeCall {
  model: Model<any>;
  // Replayed projection prefix followed by the instruction message.
  context: Context;
  maxTokens: number;
  reasoning: ThinkingLevel | undefined;
  // `undefined` keeps the retention a normal turn uses.
  cacheRetention: CacheRetention | undefined;
  // Session routing id, forwarded exactly as normal turns do.
  sessionId: string;
  // Non-message fields of the last real request's payload, reapplied on top of
  // the payload the adapter builds so the provider sees the same request shape.
  replay?: ReplayFields;
  signal?: AbortSignal;
}

export interface SummarizeOutcome {
  summary: string;
  usage?: Usage;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

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

// Run the summarize request through the host's provider stack and adapter.
// Only messages are supplied, so the adapter derives the system prompt and tool
// declarations from the replayed transcript exactly as it does for a real turn.
// `onPayload` then reapplies the captured request shape, so thinking mode, tool
// choice, tool schemas, and provider extras are the ones the provider cached.
// No tool choice is set here: the shape comes from the capture, and the
// instruction plus response validation keep the model from calling a tool.
export async function runSummarizeCall(
  call: SummarizeCall,
  complete: CompleteFunction,
): Promise<SummarizeOutcome> {
  const options: SimpleStreamOptions = {
    maxTokens: call.maxTokens,
    sessionId: call.sessionId,
    ...(call.cacheRetention === undefined ? {} : { cacheRetention: call.cacheRetention }),
    ...(call.reasoning === undefined ? {} : { reasoning: call.reasoning }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
    onPayload: (payload: unknown) => mergeReplayPayload(payload, call.replay, call.maxTokens),
  };
  const response = await complete(call.model, call.context, options);
  const summary = validateSummaryResponse(response);
  return { summary, usage: response.usage };
}
