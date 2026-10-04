// Wire-level test for the property the extension exists for: the summarize
// request's leading messages are byte-identical to a real request the provider
// already served. It drives pi-ai's real `openai-completions` provider against a
// local mock endpoint, so no provider is contacted and nothing is billed.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { buildSessionProjection, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildInstructionMessage } from "../../src/instruction.ts";
import { sliceProjection } from "../../src/prefix.ts";
import { runSummarizeCall, type CompleteFunction } from "../../src/summarize.ts";

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

// One SSE chat-completions response carrying text and DeepSeek-style cache usage. 
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

// One fresh provider collection with the mock endpoint registered. 
function modelsFor(model: Model<any>) {
  const models = createModels();
  models.setProvider(createProvider({
    id: model.provider,
    auth: { apiKey: { name: "local test endpoint", resolve: async () => ({ auth: {} }) } },
    models: [model],
    api: openAICompletionsApi(),
  }));
  return models;
}

const TOOLS: Tool[] = [
  { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } } } },
];

// A realistic conversation: two completed turns and a trailing user message. 
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
  const models = modelsFor(model);
  const messages = conversation(model);

  // A real turn: the prompt and tool loadout live in the leading system message.
  const context: Context = { systemPrompt: SYSTEM_PROMPT, messages, tools: TOOLS };
  const before = captured.length;
  await models.completeSimple(model, context, { apiKey: "test-key" });
  const realBody = captured[before];
  assert.ok(realBody !== undefined, `${label}: real request captured`);

  // The summarize call replays the same leading system message, the first two
  // turns, and appends the instruction.
  const systemMessage = createInitialSystemMessage(SYSTEM_PROMPT, TOOLS);
  assert.ok(systemMessage !== undefined, `${label}: system message built`);
  const prefix = messages.slice(0, 3);
  const complete: CompleteFunction = (
    callModel: Model<any>,
    callContext: Context,
    options: SimpleStreamOptions,
  ): Promise<AssistantMessage> => models.completeSimple(callModel, callContext, { apiKey: "test-key", ...options });

  const beforeSummarize = captured.length;
  await runSummarizeCall(
    {
      model,
      context: { messages: [systemMessage, ...prefix, buildInstructionMessage()] },
      maxTokens: 8192,
      reasoning: undefined,
      cacheRetention: "none",
      sessionId: "wire-test-session",
    },
    complete,
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

  it("holds across context edits, prompt section patches, and tool loadout changes", async () => {
    const model = modelFor({
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    });
    const models = modelsFor(model);
    const complete: CompleteFunction = (
      callModel: Model<any>,
      callContext: Context,
      options: SimpleStreamOptions,
    ): Promise<AssistantMessage> => models.completeSimple(callModel, callContext, { apiKey: "test-key", ...options });

    const projection = buildSessionProjection(transcriptEntries());
    const realBodyIndex = captured.length;
    await models.completeSimple(model, { messages: convertToLlm(projection.messages) }, { apiKey: "test-key" });
    const realBody = captured[realBodyIndex];
    assert.ok(realBody !== undefined, "mid-session: real request captured");

    const slice = sliceProjection(projection, "u3");
    const summarizeBodyIndex = captured.length;
    await runSummarizeCall(
      {
        model,
        context: { messages: [...convertToLlm(slice.messages), buildInstructionMessage()] },
        maxTokens: 8192,
        reasoning: undefined,
        cacheRetention: undefined,
        sessionId: "wire-test-session",
      },
      complete,
    );
    const summarizeBody = captured[summarizeBodyIndex];
    assert.ok(summarizeBody !== undefined, "mid-session: summarize request captured");

    // The cut sits at the trailing user message, so the replayed prefix is the
    // whole real request body minus the instruction.
    // The cut sits at the trailing user message, so the replayed prefix is the
    // real request minus that message, and the instruction takes its place. The
    // adapter may collapse system-message patches, so the wire counts differ from
    // the projection counts; the bytes of everything before the cut must not.
    assert.equal(summarizeBody.messages.length, realBody.messages.length);
    assert.deepEqual(
      summarizeBody.messages.slice(0, -1),
      realBody.messages.slice(0, -1),
      "mid-session: summarize messages reproduce the real prefix byte for byte",
    );
    assert.match(JSON.stringify(summarizeBody.messages.at(-1)), /compaction engine/);
    assert.deepEqual(summarizeBody.tools, realBody.tools, "mid-session: tool loadout matches");

    // The omitted failed attempt and its tool result appear in neither request.
    const summarizeJson = JSON.stringify(summarizeBody);
    assert.equal(summarizeJson.includes("call-omitted"), false, "mid-session: omitted tool call absent");
    assert.equal(summarizeJson.includes("omitted tool output"), false, "mid-session: omitted tool result absent");

    // The prompt patch and the added tool survive in both requests.
    assert.match(summarizeJson, /patched rule/, "mid-session: section patch replayed");
    assert.deepEqual(
      (summarizeBody.tools as Array<{ function?: { name?: string } }>).map(tool => tool.function?.name),
      ["read", "bash", "grep"],
      "mid-session: transcript-resolved tool loadout",
    );
  });
});

// A transcript that uses every mid-session mechanism Pi 1.x relies on: a prompt
// section patch, a tool loadout change, and context edits that omit a failed
// attempt. Each of these changes the model-visible prefix without rewriting the
// entries already on disk.
function transcriptEntries(): SessionEntry[] {
  const timestamp = new Date(0).toISOString();
  const message = (id: string, parentId: string | null, value: unknown): SessionEntry => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: value,
  } as SessionEntry);
  const assistant = (text: string, extra: Record<string, unknown> = {}): unknown => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "local-test",
    model: "test-model",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  });
  return [
    message("s1", null, createInitialSystemMessage(SYSTEM_PROMPT, TOOLS)),
    message("u1", "s1", { role: "user", content: [{ type: "text", text: "first request" }], timestamp: 0 }),
    message("a1", "u1", assistant("first answer")),
    message("u2", "a1", { role: "user", content: [{ type: "text", text: "second request" }], timestamp: 0 }),
    message("a2", "u2", assistant("", {
      content: [{ type: "toolCall", id: "call-omitted", name: "read", arguments: { path: "gone.ts" } }],
      stopReason: "toolUse",
    })),
    message("t1", "a2", {
      role: "toolResult",
      toolCallId: "call-omitted",
      toolName: "read",
      content: [{ type: "text", text: "omitted tool output" }],
      isError: false,
      timestamp: 0,
    }),
    {
      type: "context_edit",
      id: "e1",
      parentId: "t1",
      timestamp,
      targetId: "a2",
      replacement: null,
    },
    {
      type: "context_edit",
      id: "e2",
      parentId: "e1",
      timestamp,
      targetId: "t1",
      replacement: null,
    },
    message("s2", "e2", {
      role: "system",
      content: "",
      sections: { rules: "<rules>patched rule</rules>" },
      toolsAdded: [GREP_TOOL],
      timestamp: 0,
    }),
    message("a3", "s2", assistant("third answer")),
    message("u3", "a3", { role: "user", content: [{ type: "text", text: "third request" }], timestamp: 0 }),
  ];
}

const GREP_TOOL: Tool = {
  name: "grep",
  description: "Search files",
  parameters: { type: "object", properties: { pattern: { type: "string" } } },
};
