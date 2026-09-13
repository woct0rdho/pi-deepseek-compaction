/**
 * The compaction instruction and Pi's summary framing text.
 * @module pi-deepseek-compaction/instruction
 */

import type { UserMessage } from "@earendil-works/pi-ai";

/**
 * Version of {@link COMPACTION_INSTRUCTION}, recorded in every compaction's
 * details so a stored summary can be traced back to the prompt that produced it.
 */
export const INSTRUCTION_VERSION = 1;

/**
 * Pi's framing around a summary when it rebuilds the conversation. Not exported
 * by the Pi package, so it is copied here for exact pricing of the replacement
 * message; a wording change in Pi shifts the estimate by a few tokens.
 */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

/** Closing half of Pi's summary framing. See {@link COMPACTION_SUMMARY_PREFIX}. */
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

/** Plugin name recorded on the instruction message. */
export const INSTRUCTION_SOURCE = "@deepseek-ai/pi-deepseek-compaction";

const SECTIONS = [
  "## Primary Request and Intent",
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  "",
  "## Key Technical Concepts",
  "- [technologies, frameworks, patterns, and conventions in play]",
  "",
  "## Files and Code",
  "- [exact path: why it matters, key changes or snippets]",
  "",
  "## Errors and Fixes",
  "- [error: how it was resolved, plus any related user feedback]",
  "",
  "## Pending Jobs",
  "- [explicitly requested work not yet completed]",
  "",
  "## Current Work",
  "- [precisely what was in progress at this checkpoint]",
  "",
  "## Next Step",
  "- [the single next action, directly in line with the most recent request, or \"(none)\"]",
  "",
  "## Critical Context",
  "- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
].join("\n");

const RULES = [
  "Rules:",
  "- Write concise engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
  "- Capture user feedback and explicit instructions faithfully, especially corrections.",
  "- Do NOT mention this summarization request or that the context was compacted.",
  "- Output only the checkpoint text: do not call any tool or take any other action.",
  "- If the conversation already contains a prior summary block (a <summary>...</summary> user message), it is a PRIOR checkpoint: preserve still-true facts, drop stale ones, and merge newer information into one consolidated summary under the same structure.",
  "- Do not write <read-files>/<modified-files> lists. The harness appends them.",
].join("\n");

/**
 * Instruction appended as the final user message of the summarize request.
 * The replayed conversation stays byte-identical to the prefix of a real
 * request, so the provider can serve it from its prefix cache.
 */
export const COMPACTION_INSTRUCTION = [
  "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
  "",
  "Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write \"(none)\" for an empty section - never drop a section.",
  "",
  SECTIONS,
  "",
  RULES,
].join("\n");

/**
 * Build the instruction message for one compaction.
 * @param customInstructions - focus text from `/compact <text>`, when present.
 * @returns a user message carrying the instruction.
 */
export function buildInstructionMessage(customInstructions?: string): UserMessage {
  const focus = customInstructions?.trim();
  const text = focus === undefined || focus.length === 0
    ? COMPACTION_INSTRUCTION
    : `${COMPACTION_INSTRUCTION}\n\nAdditional focus:\n${focus}`;
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/**
 * Wrap summary text the way Pi's context builder will when it replays it.
 * @param summary - model-produced summary text.
 * @returns the exact replay text used for pricing the replacement message.
 */
export function framedSummaryText(summary: string): string {
  return `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`;
}
