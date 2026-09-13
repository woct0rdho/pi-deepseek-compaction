/**
 * Unit tests for response validation, the shrink check, and the summarize call
 * envelope. The provider call is injected, so nothing here touches a network.
 * @module pi-deepseek-compaction/tests/unit/summarize
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import {
  SummarizeError,
  assertSummaryShrinks,
  runSummarizeCall,
  validateSummaryResponse,
  type CompleteFunction,
} from "../../src/summarize.ts";

const USAGE: Usage = {
  input: 100,
  output: 10,
  cacheRead: 900,
  cacheWrite: 0,
  totalTokens: 1010,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "SUMMARY" }],
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

describe("validateSummaryResponse", () => {
  it("joins text blocks", () => {
    const summary = validateSummaryResponse(
      assistant({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }),
    );
    assert.equal(summary, "one\ntwo");
  });

  it("rejects provider errors", () => {
    assert.throws(
      () => validateSummaryResponse(assistant({ stopReason: "error", errorMessage: "boom" })),
      /boom/,
    );
  });

  it("rejects an aborted generation", () => {
    assert.throws(() => validateSummaryResponse(assistant({ stopReason: "aborted" })), SummarizeError);
  });

  it("rejects a truncated generation", () => {
    assert.throws(() => validateSummaryResponse(assistant({ stopReason: "length" })), /incomplete/);
  });

  it("rejects a tool call", () => {
    assert.throws(
      () =>
        validateSummaryResponse(
          assistant({ content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }] }),
        ),
      /call a tool/,
    );
  });

  it("rejects empty text", () => {
    assert.throws(() => validateSummaryResponse(assistant({ content: [] })), /no text/);
  });
});

describe("assertSummaryShrinks", () => {
  it("accepts a summary smaller than the replaced history", () => {
    const result = assertSummaryShrinks("short summary", 5_000);
    assert.ok(result.summaryTokens > 0);
    assert.ok(result.replacementTokens < 5_000);
  });

  it("rejects a summary that is not smaller", () => {
    assert.throws(() => assertSummaryShrinks("x".repeat(4_000), 100), /not smaller/);
  });
});

describe("runSummarizeCall", () => {
  const model = {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  } as unknown as Model<any>;

  it("sends the replayed prefix plus instruction with tool choice disabled", async () => {
    const calls: Array<{ context: unknown; options: Record<string, unknown> }> = [];
    const complete = (async (_model: unknown, context: unknown, options: Record<string, unknown>) => {
      calls.push({ context, options });
      return assistant({});
    }) as unknown as CompleteFunction;

    const outcome = await runSummarizeCall(
      {
        model,
        systemPrompt: "SYSTEM",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
          { role: "user", content: [{ type: "text", text: "INSTRUCTION" }], timestamp: 1 },
        ],
        tools: [{ name: "read", description: "d", parameters: { type: "object" } }],
        maxTokens: 4096,
        reasoning: "high",
        cacheRetention: "none",
        apiKey: "key",
      },
      complete,
    );

    assert.equal(outcome.summary, "SUMMARY");
    assert.equal(outcome.usage, USAGE);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.context, {
      systemPrompt: "SYSTEM",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
        { role: "user", content: [{ type: "text", text: "INSTRUCTION" }], timestamp: 1 },
      ],
      tools: [{ name: "read", description: "d", parameters: { type: "object" } }],
    });
    assert.equal(calls[0]?.options.maxTokens, 4096);
    assert.equal(calls[0]?.options.cacheRetention, "none");
    assert.equal(calls[0]?.options.toolChoice, "none");
    assert.equal(calls[0]?.options.reasoning, "high");
    assert.equal(calls[0]?.options.apiKey, "key");
  });

  it("omits reasoning when the call runs without thinking", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const complete = (async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
      calls.push(options);
      return assistant({});
    }) as unknown as CompleteFunction;

    await runSummarizeCall(
      {
        model,
        systemPrompt: "SYSTEM",
        messages: [],
        tools: [],
        maxTokens: 100,
        reasoning: undefined,
        cacheRetention: "none",
        apiKey: "key",
      },
      complete,
    );
    assert.equal("reasoning" in (calls[0] ?? {}), false);
  });

  it("propagates a rejected provider call", async () => {
    const complete = (async () => {
      throw new Error("network down");
    }) as unknown as CompleteFunction;
    await assert.rejects(
      runSummarizeCall(
        {
          model,
          systemPrompt: "",
          messages: [],
          tools: [],
          maxTokens: 100,
          reasoning: undefined,
          cacheRetention: "none",
          apiKey: "key",
        },
        complete,
      ),
      /network down/,
    );
  });
});
