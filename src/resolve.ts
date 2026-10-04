// Resolution of the summarize call's model, thinking level, and output cap.
// A {@link ConfigProblem} means the configured value cannot be honored. The
// caller reports it and cancels the compaction.

import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { SummarizeThinkingLevel } from "./types.ts";

export class ConfigProblem extends Error {
  override readonly name = "ConfigProblem";
}

export function modelKey(model: Pick<Model<never>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

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

export function resolveMaxTokens(
  configured: number,
  reserveTokens: number,
  modelMaxTokens: number,
): number {
  const derived = configured > 0 ? configured : Math.floor(0.8 * reserveTokens);
  const capped = modelMaxTokens > 0 ? Math.min(derived, modelMaxTokens) : derived;
  return Math.max(1, capped);
}
