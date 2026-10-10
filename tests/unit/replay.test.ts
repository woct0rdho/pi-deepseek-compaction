// The replay module decides what a summarize call reuses from the last real
// request. It is the guard against the silent cache misses this extension
// exists to avoid: a request shape rebuilt from settings (a tool_choice, a
// thinking mode) is a different cache entry even when every prompt byte matches.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeReplayPayload,
  payloadShell,
  replayForCapture,
  replayableFields,
  OUTPUT_CAP_FIELDS,
} from "../../src/replay.ts";

describe("payloadShell", () => {
  it("keeps every non-message field and counts the messages", () => {
    const payload = {
      model: "deepseek-flash",
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function" }],
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      messages: [{ role: "system" }, { role: "user" }],
    };
    const shell = payloadShell(payload);
    assert.deepEqual(shell?.fields, {
      model: "deepseek-flash",
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function" }],
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    assert.equal(shell?.messageCount, 2);
  });

  it("strips every output cap and deep-clones the replay", () => {
    const tools = [{ type: "function" }];
    const payload: Record<string, unknown> = {
      messages: [],
      tools,
      max_tokens: 384_000,
      ...Object.fromEntries(OUTPUT_CAP_FIELDS.map(field => [field, 1])),
    };
    const shell = payloadShell(payload);
    // The clone is independent of the payload object, so a later mutation of the
    // sent body (or by a later extension) cannot change what the replay sends.
    tools.push({ type: "other" });
    assert.deepEqual(shell?.fields.tools, [{ type: "function" }]);
    for (const field of OUTPUT_CAP_FIELDS) assert.equal(field in shell!.fields, false);
  });

  it("reports no shell for payloads that are not objects", () => {
    assert.equal(payloadShell(undefined), undefined);
    assert.equal(payloadShell("stream"), undefined);
    assert.equal(payloadShell([{ role: "user" }]), undefined);
    assert.equal(payloadShell(null), undefined);
  });
});

describe("replayableFields", () => {
  it("keeps neutral tool choices and drops forced ones", () => {
    const { fields, adjusted } = replayableFields(
      payloadShell({
        messages: [],
        tool_choice: "none",
        thinking: { type: "enabled" },
      })!,
    );
    assert.deepEqual(fields, { tool_choice: "none", thinking: { type: "enabled" } });
    assert.deepEqual(adjusted, []);

    const forced = replayableFields(
      payloadShell({ messages: [], tool_choice: "required", model: "x" })!,
    );
    assert.deepEqual(forced.fields, { model: "x" });
    assert.deepEqual(forced.adjusted, ["tool_choice"]);

    const named = replayableFields(
      payloadShell({ messages: [], tool_choice: { type: "function", function: { name: "read" } } })!,
    );
    assert.deepEqual(named.fields, {});
    assert.deepEqual(named.adjusted, ["tool_choice"]);
  });

  it("keeps auto, which is what real turns usually send", () => {
    const { fields, adjusted } = replayableFields(payloadShell({ messages: [], tool_choice: "auto" })!);
    assert.deepEqual(fields, { tool_choice: "auto" });
    assert.deepEqual(adjusted, []);
  });
});

describe("replayForCapture", () => {
  const shell = payloadShell({ messages: [], thinking: { type: "enabled" } })!;

  it("replays only a same-model capture", () => {
    assert.deepEqual(
      replayForCapture({ modelKey: "deepseek/deepseek-flash", shell }, "deepseek/deepseek-flash")?.fields,
      { thinking: { type: "enabled" } },
    );
    assert.equal(replayForCapture({ modelKey: "deepseek/deepseek-chat", shell }, "deepseek/deepseek-flash"), undefined);
    assert.equal(replayForCapture({ modelKey: "deepseek/deepseek-flash" }, "deepseek/deepseek-flash"), undefined);
    assert.equal(replayForCapture(undefined, "deepseek/deepseek-flash"), undefined);
  });
});

describe("mergeReplayPayload", () => {
  const replay = replayableFields(payloadShell({
    messages: ["stale"],
    max_tokens: 384_000,
    model: "deepseek-flash",
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  })!);

  it("keeps the built messages and the captured shape", () => {
    const built = {
      model: "deepseek-flash",
      max_tokens: 8192,
      messages: ["ours"],
      stream: true,
    };
    assert.deepEqual(mergeReplayPayload(built, replay, 8192), {
      model: "deepseek-flash",
      max_tokens: 8192,
      messages: ["ours"],
      stream: true,
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
  });

  it("applies the output cap to whichever field the adapter uses", () => {
    const merged = mergeReplayPayload({ messages: [], max_completion_tokens: 1 }, replay, 4096) as Record<string, unknown>;
    assert.equal(merged.max_completion_tokens, 4096);
    assert.equal("max_tokens" in merged, false);
    // Without a cap the adapter's own value stays untouched.
    const untouched = mergeReplayPayload({ messages: [], max_tokens: 1 }, replay, undefined) as Record<string, unknown>;
    assert.equal(untouched.max_tokens, 1);
  });

  it("returns the built payload when there is nothing to replay", () => {
    const built = { messages: [], model: "m" };
    assert.equal(mergeReplayPayload(built, undefined, 1024), built);
    assert.equal(mergeReplayPayload("not-an-object", replay, 1024), "not-an-object");
    assert.equal(mergeReplayPayload(undefined, replay, 1024), undefined);
  });
});
