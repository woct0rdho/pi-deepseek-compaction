/**
 * Unit tests for model, thinking-level, and output-cap resolution.
 * @module pi-deepseek-compaction/tests/unit/resolve
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  ConfigProblem,
  modelKey,
  resolveMaxTokens,
  resolveSummarizationModel,
  resolveThinkingLevel,
} from "../../src/resolve.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    ...overrides,
  } as Model<any>;
}

describe("resolveSummarizationModel", () => {
  it("uses the session model when no model is configured", () => {
    const session = model();
    assert.equal(resolveSummarizationModel("", session, () => undefined), session);
  });

  it("resolves a configured model through the registry", () => {
    const session = model();
    const configured = model({ id: "deepseek-flash" });
    const found = resolveSummarizationModel("deepseek-flash", session, (provider, id) => {
      assert.equal(provider, "deepseek");
      assert.equal(id, "deepseek-flash");
      return configured;
    });
    assert.equal(found, configured);
  });

  it("fails when no session model is selected", () => {
    assert.throws(() => resolveSummarizationModel("", undefined, () => undefined), ConfigProblem);
  });

  it("fails when the configured model is not registered", () => {
    assert.throws(
      () => resolveSummarizationModel("missing", model(), () => undefined),
      /not registered for provider "deepseek"/,
    );
  });
});

describe("resolveThinkingLevel", () => {
  const mapped = model({ thinkingLevelMap: { minimal: null, low: "low", high: "high", xhigh: null } });

  it("defaults to the session level", () => {
    assert.equal(resolveThinkingLevel("", "high", mapped), "high");
  });

  it("returns undefined for an explicit off or an absent session level", () => {
    assert.equal(resolveThinkingLevel("off", "high", mapped), undefined);
    assert.equal(resolveThinkingLevel("", undefined, mapped), undefined);
  });

  it("rejects a level the model marks unsupported", () => {
    assert.throws(() => resolveThinkingLevel("xhigh", undefined, mapped), /does not support thinking level/);
  });

  it("rejects any level for a non-reasoning model", () => {
    assert.throws(
      () => resolveThinkingLevel("high", undefined, model({ reasoning: false })),
      /does not support thinking level/,
    );
  });

  it("passes an unmapped level through", () => {
    assert.equal(resolveThinkingLevel("medium", undefined, mapped), "medium");
  });
});

describe("resolveMaxTokens", () => {
  it("applies Pi's ratio when unset", () => {
    assert.equal(resolveMaxTokens(0, 16_384, 384_000), 13_107);
  });

  it("honors an explicit value", () => {
    assert.equal(resolveMaxTokens(2048, 16_384, 384_000), 2048);
  });

  it("clamps to the model's maximum output", () => {
    assert.equal(resolveMaxTokens(0, 16_384, 4096), 4096);
  });

  it("never returns zero", () => {
    assert.equal(resolveMaxTokens(0, 0, 0), 1);
  });
});

describe("modelKey", () => {
  it("renders provider and model id", () => {
    assert.equal(modelKey(model()), "deepseek/deepseek-v4-pro");
  });
});
