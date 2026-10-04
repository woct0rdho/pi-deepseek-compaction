// Opt-in live cache test. It sends a small prefix to a real DeepSeek-compatible
// endpoint twice - once as a normal request, once as the summarize request - and
// checks that the second call reads the first call's prefix from the provider's
// cache.
//
// Cost control: the fixture is roughly one thousand tokens, output is capped,
// and the test refuses to run without `PI_DEEPSEEK_COMPACTION_LIVE=1`. It is
// never part of `npm test` and never wired into CI.
//
// Provider behavior is best-effort by design: a provider may not have finished
// building the cache entry for the newest request when the summarize call
// arrives, so the test retries once and reports the measured ratio instead of
// demanding a fixed one.
//
// Environment:
//   PI_DEEPSEEK_COMPACTION_LIVE=1        required opt-in
//   DEEPSEEK_API_KEY                     credential, falls back to auth.json
//   PI_DEEPSEEK_COMPACTION_LIVE_MODEL    model id (default deepseek-flash)
//   PI_DEEPSEEK_COMPACTION_LIVE_BASE_URL base URL (default https://api.deepseek.com)

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import { createInitialSystemMessage, createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { buildInstructionMessage } from "../../src/instruction.ts";
import { priceMessages, priceText } from "../../src/prefix.ts";
import { runSummarizeCall, type CompleteFunction } from "../../src/summarize.ts";

const MODEL_ID = process.env.PI_DEEPSEEK_COMPACTION_LIVE_MODEL?.trim() || "deepseek-flash";
const BASE_URL = process.env.PI_DEEPSEEK_COMPACTION_LIVE_BASE_URL?.trim() || "https://api.deepseek.com";
// One routing id for the warm-up and summarize calls, mirroring a real session.
const SESSION_ID = "pi-deepseek-compaction-live";

function readApiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(authPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const deepseek = parsed.deepseek;
    if (typeof deepseek !== "object" || deepseek === null) return undefined;
    const key = (deepseek as Record<string, unknown>).key;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function model(): Model<any> {
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
  } as unknown as Model<any>;
}

const SYSTEM_PROMPT =
  "You are a coding agent. Follow the repository conventions and reply briefly. "
  + "Prefer small, reviewable changes and keep durable notes about decisions.";

// A few hundred tokens of ordinary engineering conversation.
const PREFIX_TEXT: Array<{ role: "user" | "assistant"; text: string }> = [
  {
    role: "user",
    text: "We are refactoring the session persistence layer. The JSONL writer stays the single source of truth and the projection cache must remain optional so a cold start never depends on it. Please confirm you understand the constraint and name the two files you would touch first.",
  },
  {
    role: "assistant",
    text: "Understood. The JSONL writer remains authoritative, and the projection cache is a derived accelerator that can be dropped and rebuilt. I would start with src/session/log-writer.ts for the append path and src/session/projection-cache.ts for the rebuild path.",
  },
  {
    role: "user",
    text: "Agreed. Also note that compaction summaries must be reconstructed from the log alone, so any new model-visible input needs a corresponding session event. Keep the queue bounded and make the writer flush before the next prompt is admitted.",
  },
  {
    role: "assistant",
    text: "Recorded: summaries are reconstructable from the log, new model-visible inputs need events, the writer flushes before the next prompt, and the queue stays bounded. Next I would add a flush checkpoint after each committed turn.",
  },
];

function conversation(): Message[] {
  return PREFIX_TEXT.map(entry => entry.role === "user"
    ? ({ role: "user", content: [{ type: "text", text: entry.text }], timestamp: 0 } as Message)
    : ({
        role: "assistant",
        content: [{ type: "text", text: entry.text }],
        api: "openai-completions",
        provider: "deepseek",
        model: MODEL_ID,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      } as Message));
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (process.env.PI_DEEPSEEK_COMPACTION_LIVE !== "1") {
    console.log(
      "live test skipped: set PI_DEEPSEEK_COMPACTION_LIVE=1 to run it."
        + " It sends roughly a thousand tokens to the real provider and is never part of the default test run.",
    );
    return;
  }
  const apiKey = readApiKey();
  if (apiKey === undefined) {
    console.log("live test skipped: no DEEPSEEK_API_KEY and no deepseek key in ~/.pi/agent/auth.json.");
    return;
  }

  const target = model();
  const models = createModels();
  models.setProvider(createProvider({
    id: target.provider,
    auth: { apiKey: { name: "DeepSeek", resolve: async () => ({ auth: {} }) } },
    models: [target],
    api: openAICompletionsApi(),
  }));
  const complete: CompleteFunction = (callModel, context, options) =>
    models.completeSimple(callModel, context, { apiKey, ...options });
  const prefix = conversation();
  const prefixTokens = priceText(SYSTEM_PROMPT) + priceMessages(prefix);

  console.log(`live: model ${target.provider}/${target.id} at ${BASE_URL}`);
  console.log(`live: fixture prefix ~${prefixTokens} tokens`);

  // Warm the provider's cache with a request whose prompt starts with the same
  // system prompt and messages the summarize call will replay.
  await models.completeSimple(
    target,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [...prefix, { role: "user", content: [{ type: "text", text: "Reply with the single word ACK." }], timestamp: 0 }],
    },
    { apiKey, maxTokens: 16, cacheRetention: "none", sessionId: SESSION_ID },
  );

  const systemMessage = createInitialSystemMessage(SYSTEM_PROMPT, []);
  assert.ok(systemMessage !== undefined, "system message built");
  const attempt = async (): Promise<Awaited<ReturnType<typeof runSummarizeCall>>> =>
    runSummarizeCall(
      {
        model: target,
        context: { messages: [systemMessage, ...prefix, buildInstructionMessage()] },
        maxTokens: 4096,
        reasoning: undefined,
        cacheRetention: "none",
        sessionId: SESSION_ID,
      },
      complete,
    );

  // Cache construction takes seconds; retry once before measuring.
  let outcome = await attempt();
  if ((outcome.usage?.cacheRead ?? 0) === 0) {
    await sleep(5_000);
    outcome = await attempt();
  }

  const usage = outcome.usage;
  assert.ok(usage !== undefined, "provider reported usage");
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const ratio = prefixTokens > 0 ? (usage.cacheRead / prefixTokens).toFixed(2) : "n/a";
  console.log(
    `live: cacheRead ${usage.cacheRead} / prefix ~${prefixTokens} = ${ratio}`
      + ` (prompt ${promptTokens}, cacheWrite ${usage.cacheWrite}, output ${usage.output},`
      + ` cost $${usage.cost.total.toFixed(6)})`,
  );
  assert.equal(usage.cacheWrite, 0, "no cache write is billed");
  assert.ok(usage.cacheRead > 0, "the provider served part of the replayed prefix from cache");
  console.log("live: ok");
}

await main();
