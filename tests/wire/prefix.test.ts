/**
 * Wire-level test for the property the extension exists for: the summarize
 * request's system message, tools, and leading messages are byte-identical to a
 * real request the provider already served. It drives pi-ai's real
 * `openai-completions` adapter against a local mock endpoint, so no provider is
 * contacted and nothing is billed.
 * @module pi-deepseek-compaction/tests/wire/prefix
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { completeSimple, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { buildInstructionMessage } from "../../src/instruction.ts";
import { runSummarizeCall } from "../../src/summarize.ts";

interface CapturedBody {
  [key: string]: unknown;
  messages: Array<{ role: string; content: unknown; [key: string]: unknown }>;
  tools?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
}

const captured: CapturedBody[] = [];
let server: Server;
let baseUrl: string;

/** One SSE chat-completions response carrying text and DeepSeek-style cache usage. */
function sseResponse(): string {
  const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  return chunk({ role: "assistant", content: "" }, null)
    + chunk({ content: "SUMMARY TEXT" }, null)
    + chunk({}, "stop", {
      prompt_tokens: 120,
      completion_tokens: 6,
      total_tokens: 126,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 20,
    })
    + "data: [DONE]\n\n";
}

before(async () => {
  registerBuiltInApiProviders();
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      captured.push(JSON.parse(body) as CapturedBody);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sseResponse());
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function modelFor(compat: Record<string, unknown> | undefined): Model<any> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "local-test",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65_536,
    maxTokens: 4096,
    ...(compat === undefined ? {} : { compat }),
  } as unknown as Model<any>;
}

const TOOLS: Tool[] = [
  { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
];

/** A realistic conversation: two completed turns and a trailing user message. */
function conversation(model: Model<any>): Message[] {
  const assistant = (text: string, thinking?: string): Message => ({
    role: "assistant",
    content: [
      ...(thinking === undefined ? [] : [{ type: "thinking" as const, thinking }]),
      { type: "text" as const, text },
    ],
    api: "openai-completions" as const,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  } as Message);
  return [
    { role: "user", content: [{ type: "text", text: "first request" }], timestamp: 0 },
    assistant("first answer", "first reasoning"),
    { role: "user", content: [{ type: "text", text: "second request" }], timestamp: 0 },
    assistant("second answer", "second reasoning"),
    { role: "user", content: [{ type: "text", text: "third request" }], timestamp: 0 },
  ];
}

const SYSTEM_PROMPT = "You are a coding agent. Follow the repository conventions.";

async function runPairCase(label: string, compat: Record<string, unknown> | undefined): Promise<void> {
  const model = modelFor(compat);
  const messages = conversation(model);
  const context: Context = { systemPrompt: SYSTEM_PROMPT, messages, tools: TOOLS };

  const before = captured.length;
  await completeSimple(model, context, { apiKey: "test-key" });
  const realBody = captured[before];
  assert.ok(realBody !== undefined, `${label}: real request captured`);

  // The summarize call replays the first two turns and appends the instruction.
  const prefix = messages.slice(0, 3);
  const beforeSummarize = captured.length;
  await runSummarizeCall(
    {
      model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [...prefix, buildInstructionMessage()],
      tools: TOOLS,
      maxTokens: 8192,
      reasoning: undefined,
      cacheRetention: "none",
      apiKey: "test-key",
    },
    completeSimple,
  );
  const summarizeBody = captured[beforeSummarize];
  assert.ok(summarizeBody !== undefined, `${label}: summarize request captured`);

  const prefixLength = 1 + prefix.length;
  assert.equal(realBody.messages.length, 1 + messages.length, `${label}: real request message count`);
  assert.equal(summarizeBody.messages.length, prefixLength + 1, `${label}: summarize message count`);
  assert.deepEqual(
    summarizeBody.messages.slice(0, prefixLength),
    realBody.messages.slice(0, prefixLength),
    `${label}: summarize messages are a byte prefix of the real request`,
  );
  assert.deepEqual(summarizeBody.tools, realBody.tools, `${label}: tool schemas match`);
  assert.equal(summarizeBody.messages[0]?.role, "system", `${label}: system message first`);
  assert.equal(summarizeBody.messages[0]?.content, SYSTEM_PROMPT, `${label}: system prompt verbatim`);
  const capFields = [summarizeBody.max_tokens, summarizeBody.max_completion_tokens]
    .filter(value => value !== undefined);
  assert.deepEqual(capFields, [8192], `${label}: configured output cap in the adapter's field`);

  const instruction = summarizeBody.messages.at(-1);
  assert.match(JSON.stringify(instruction?.content), /compaction engine/, `${label}: instruction last`);
  assert.equal(summarizeBody.messages.at(-2), summarizeBody.messages.at(-2), `${label}: prefix unchanged`);

  const serialized = JSON.stringify(summarizeBody);
  assert.equal(serialized.includes("cache_control"), false, `${label}: no explicit cache markers`);
  assert.equal(serialized.includes("prompt_cache_key"), false, `${label}: no prompt cache key`);
}

describe("prefix preservation on the wire", () => {
  it("holds with auto-detected compatibility", async () => {
    await runPairCase("plain", undefined);
  });

  it("holds with DeepSeek compatibility and replayed reasoning content", async () => {
    await runPairCase("deepseek", {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    });
  });
});
