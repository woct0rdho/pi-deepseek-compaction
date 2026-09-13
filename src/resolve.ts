/**
 * Resolution of the summarize call's model, thinking level, and output cap.
 * A {@link ConfigProblem} means the configured value cannot be honored; the
 * caller reports it and cancels the compaction.
 * @module pi-deepseek-compaction/resolve
 */

import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { SummarizeThinkingLevel } from "./types.ts";

/** A configuration value that cannot be honored, such as an unregistered model. */
export class ConfigProblem extends Error {
  override readonly name = "ConfigProblem";
}

/** Render a `provider/model` key. */
export function modelKey(model: Pick<Model<never>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Choose the model that will write the summary.
 * @param configuredModel - `compaction.model`; empty selects the session model.
 * @param sessionModel - the model of the current session, when one is selected.
 * @param find - registry lookup used for a configured model id.
 * @returns the model to call.
 * @throws {ConfigProblem} when no session model exists or the configured model is not registered.
 */
export function resolveSummarizationModel(
  configuredModel: string,
  sessionModel: Model<any> | undefined,
  find: (provider: string, modelId: string) => Model<any> | undefined,
): Model<any> {
  if (configuredModel.length === 0) {
    if (sessionModel === undefined) {
      throw new ConfigProblem("no model is selected for this session");
    }
    return sessionModel;
  }
  if (sessionModel === undefined) {
    throw new ConfigProblem(`compaction.model "${configuredModel}" cannot be resolved without a session model`);
  }
  const found = find(sessionModel.provider, configuredModel);
  if (found === undefined) {
    throw new ConfigProblem(
      `compaction.model "${configuredModel}" is not registered for provider "${sessionModel.provider}"`,
    );
  }
  return found;
}

/**
 * Choose the thinking level for the summarize call.
 * @param configured - `compaction.thinkingLevel`; empty selects the session level.
 * @param sessionLevel - the session's current level, when known.
 * @param model - resolved summarize model.
 * @returns the level to request, or undefined for a call without thinking.
 * @throws {ConfigProblem} when the model cannot honor the requested level.
 */
export function resolveThinkingLevel(
  configured: SummarizeThinkingLevel | "",
  sessionLevel: SummarizeThinkingLevel | undefined,
  model: Model<any>,
): ThinkingLevel | undefined {
  const level = configured !== "" ? configured : sessionLevel;
  if (level === undefined || level === "off") return undefined;
  if (!model.reasoning) {
    throw new ConfigProblem(`model ${modelKey(model)} does not support thinking level "${level}"`);
  }
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) {
    throw new ConfigProblem(`model ${modelKey(model)} does not support thinking level "${level}"`);
  }
  return level;
}

/**
 * Resolve the summarization output cap. `0` selects Pi's own formula,
 * `floor(0.8 * reserveTokens)`, clamped by the model's maximum output.
 * @param configured - `compaction.maxTokens`.
 * @param reserveTokens - Pi's configured response reserve.
 * @param modelMaxTokens - the model's maximum output, when it declares one.
 * @returns a positive token cap.
 */
export function resolveMaxTokens(
  configured: number,
  reserveTokens: number,
  modelMaxTokens: number,
): number {
  const derived = configured > 0 ? configured : Math.floor(0.8 * reserveTokens);
  const capped = modelMaxTokens > 0 ? Math.min(derived, modelMaxTokens) : derived;
  return Math.max(1, capped);
}
