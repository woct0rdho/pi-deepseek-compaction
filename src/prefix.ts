/**
 * Prefix construction and pricing. The replayed prefix is Pi's own compaction-aware
 * context truncated at `firstKeptEntryId`, which makes it the leading part of the
 * message list a real turn sends.
 * @module pi-deepseek-compaction/prefix
 */

import { createHash } from "node:crypto";
import {
  buildContextEntries,
  convertToLlm,
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Tool } from "@earendil-works/pi-ai";

/** Failure while rebuilding the prefix; always cancels the compaction. */
export class PrefixBuildError extends Error {
  override readonly name = "PrefixBuildError";
}

/** Minimal extension surface needed to read the active tool set. */
export interface ToolSource {
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
}

/**
 * Rebuild the messages that precede the summary's replacement point.
 * @param branchEntries - Pi's branch entries for the session, as delivered by the hook.
 * @param firstKeptEntryId - Pi's cut point; the first entry that stays in context.
 * @returns agent messages in context order, ending just before the cut.
 * @throws {PrefixBuildError} when the cut point is absent from the context.
 */
export function buildPrefixMessages(
  branchEntries: readonly SessionEntry[],
  firstKeptEntryId: string,
): AgentMessage[] {
  const contextEntries = buildContextEntries([...branchEntries]);
  const cut = contextEntries.findIndex(entry => entry.id === firstKeptEntryId);
  if (cut < 0) {
    throw new PrefixBuildError(
      `cut entry ${firstKeptEntryId} is absent from the compaction-aware context; cannot rebuild a prefix`,
    );
  }
  if (cut === 0) {
    throw new PrefixBuildError("cut entry leaves no messages to summarize");
  }
  return contextEntries.slice(0, cut).flatMap(entry => sessionEntryToContextMessages(entry));
}

/**
 * Convert agent messages to the LLM messages a provider request carries.
 * @param messages - agent messages from {@link buildPrefixMessages}.
 * @returns provider-facing messages.
 */
export function toLlmMessages(messages: readonly AgentMessage[]): Message[] {
  return convertToLlm([...messages]);
}

/**
 * Collect the tool schemas a real turn sends, in Pi's registration order.
 * @param source - extension API or any equivalent tool provider.
 * @returns tool definitions in the order the provider sees them.
 */
export function collectActiveTools(source: ToolSource): Tool[] {
  const active = new Set(source.getActiveTools());
  return source
    .getAllTools()
    .filter(tool => active.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

/** Price one text block the way Pi prices a text-only message. */
export function priceText(text: string): number {
  const message: Message = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 0,
  };
  return estimateTokens(message as AgentMessage);
}

/**
 * Price a message list with Pi's own estimator.
 * @param messages - agent messages to price.
 * @returns the sum of Pi's per-message estimates.
 */
export function priceMessages(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
  return total;
}

/** Canonicalize JSON with sorted object keys so key order cannot change a hash. */
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

/**
 * Fingerprint a message list for prefix comparison. The same message content
 * always produces the same fingerprint regardless of object key order.
 * @param messages - agent messages to fingerprint.
 * @returns one hash per message, in order.
 */
export function fingerprintMessages(messages: readonly AgentMessage[]): string[] {
  return messages.map(message =>
    createHash("sha1").update(JSON.stringify(canonicalize(message))).digest("hex"),
  );
}

/**
 * Count how many leading messages a rebuilt prefix shares with a captured request.
 * @param captured - fingerprints from the last real request, when available.
 * @param current - fingerprints of the rebuilt prefix.
 * @returns the length of the shared leading run.
 */
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
