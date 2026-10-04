// Prefix slicing and pricing. The prefix is Pi's own session projection - the
// model-visible messages after context edits and system-message patches - cut at
// `firstKeptEntryId`. Passing exactly those messages to the provider adapter
// reproduces a real request's bytes, because the adapter derives the system
// prompt and tool declarations from the transcript itself.

import { createHash } from "node:crypto";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export class PrefixBuildError extends Error {
  override readonly name = "PrefixBuildError";
}

export interface ProjectionLike {
  entries: readonly ProjectedSessionEntry[];
}

// The model-visible context split at one compaction boundary.
export interface PrefixSlice {
  // Messages before the cut, in order, including the system prompt state.
  messages: AgentMessage[];
  // Messages the summary replaces: the prefix without system prompt state.
  summarized: AgentMessage[];
}

export function sliceProjection(projection: ProjectionLike, firstKeptEntryId: string): PrefixSlice {
  const cut = projection.entries.findIndex(entry => entry.sourceEntry.id === firstKeptEntryId);
  if (cut < 0) {
    throw new PrefixBuildError(
      `cut entry ${firstKeptEntryId} is absent from the session projection; refusing to summarize a different span`,
    );
  }
  const messages = projection.entries.slice(0, cut).flatMap(entry => entry.messages);
  const summarized = messages.filter(message => message.role !== "system");
  if (summarized.length === 0) {
    throw new PrefixBuildError("the projection holds no conversation messages to summarize before the cut");
  }
  return { messages, summarized };
}

export function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
  return convertToLlm([...messages]);
}

export function priceText(text: string): number {
  const message: Message = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
  return estimateTokens(message as AgentMessage);
}

export function priceMessages(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
  return total;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
    return sorted;
  }
  return value;
}

export function fingerprintMessages(messages: readonly AgentMessage[]): string[] {
  return messages.map(message =>
    createHash("sha1").update(JSON.stringify(canonicalize(message))).digest("hex"),
  );
}

export function sharedPrefixMessageCount(
  captured: readonly string[] | undefined,
  current: readonly string[],
): number {
  if (captured === undefined) return 0;
  const limit = Math.min(captured.length, current.length);
  let shared = 0;
  while (shared < limit && captured[shared] === current[shared]) shared += 1;
  return shared;
}
