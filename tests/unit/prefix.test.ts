import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RequestCaptureStore } from "../../src/capture.ts";
import {
  PrefixBuildError,
  fingerprintMessages,
  priceMessages,
  priceText,
  sharedPrefixMessageCount,
  sliceProjection,
  toLlmMessages,
} from "../../src/prefix.ts";

const TIMESTAMP = new Date(0).toISOString();

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  };
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-flash",
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
    },
  };
}

function systemEntry(
  id: string,
  parentId: string | null,
  content: string,
  sections?: Record<string, string>,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: TIMESTAMP,
    message: {
      role: "system",
      content,
      ...(sections === undefined ? {} : { sections }),
      timestamp: 0,
    },
  };
}

function compactionEntry(id: string, parentId: string, summary: string, firstKeptEntryId: string): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: TIMESTAMP,
    summary,
    firstKeptEntryId,
    tokensBefore: 1000,
  };
}

function contextEditEntry(id: string, parentId: string, targetId: string): SessionEntry {
  return {
    type: "context_edit",
    id,
    parentId,
    timestamp: TIMESTAMP,
    targetId,
    replacement: null,
  };
}

function projectAndSlice(entries: SessionEntry[], firstKeptEntryId: string) {
  return sliceProjection(buildSessionProjection(entries), firstKeptEntryId);
}

describe("sliceProjection", () => {
  it("returns the leading messages before Pi's cut", () => {
    const entries = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "answer one"),
      userEntry("u2", "a1", "second"),
      assistantEntry("a2", "u2", "answer two"),
    ];
    const slice = projectAndSlice(entries, "u2");
    assert.deepEqual(slice.messages.map(message => message.role), ["user", "assistant"]);
    assert.deepEqual(slice.summarized.map(message => message.role), ["user", "assistant"]);
    assert.deepEqual(toLlmMessages(slice.messages).map(message => message.role), ["user", "assistant"]);
  });

  it("replays the previous summary message when the cut sits after it", () => {
    const entries = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "answer one"),
      userEntry("u2", "a1", "second"),
      compactionEntry("c1", "u2", "PRIOR SUMMARY", "u2"),
      assistantEntry("a2", "c1", "answer two"),
      userEntry("u3", "a2", "third"),
    ];
    const slice = projectAndSlice(entries, "u3");
    assert.deepEqual(slice.messages.map(message => message.role), ["compactionSummary", "user", "assistant"]);
    const llm = toLlmMessages(slice.messages);
    assert.equal(llm.length, 3);
    assert.match(JSON.stringify(llm[0]), /PRIOR SUMMARY/);
  });

  it("keeps the kept tail out of the prefix", () => {
    const entries = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "answer one"),
      userEntry("u2", "a1", "second"),
    ];
    const slice = projectAndSlice(entries, "a1");
    assert.deepEqual(slice.messages.map(message => message.role), ["user"]);
    assert.deepEqual(slice.summarized.map(message => message.role), ["user"]);
  });

  it("keeps system prompt state in the prefix but out of the summarized span", () => {
    const entries = [
      systemEntry("s1", null, "You are a coding agent.", { rules: "<rules>be terse</rules>" }),
      userEntry("u1", "s1", "first"),
      assistantEntry("a1", "u1", "answer one"),
      systemEntry("s2", "a1", "", { rules: "<rules>be brief</rules>" }),
      userEntry("u2", "s2", "second"),
    ];
    const slice = projectAndSlice(entries, "u2");
    assert.deepEqual(slice.messages.map(message => message.role), ["system", "user", "assistant", "system"]);
    assert.deepEqual(slice.summarized.map(message => message.role), ["user", "assistant"]);
  });

  it("applies append-only context edits before slicing", () => {
    const entries = [
      userEntry("u1", null, "omitted by an edit"),
      assistantEntry("a1", "u1", "answer one"),
      contextEditEntry("e1", "a1", "u1"),
      userEntry("u2", "e1", "second"),
    ];
    const slice = projectAndSlice(entries, "u2");
    assert.deepEqual(slice.messages.map(message => message.role), ["assistant"]);
  });

  it("rejects a cut that is absent from the projection", () => {
    const entries = [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "answer one")];
    assert.throws(() => projectAndSlice(entries, "missing"), PrefixBuildError);
  });

  it("rejects a cut that leaves nothing to summarize", () => {
    const entries = [userEntry("u1", null, "first")];
    assert.throws(() => projectAndSlice(entries, "u1"), PrefixBuildError);
  });

  it("rejects a prefix that holds only system prompt state", () => {
    const entries = [
      systemEntry("s1", null, "You are a coding agent."),
      userEntry("u1", "s1", "first"),
    ];
    assert.throws(() => projectAndSlice(entries, "u1"), /no conversation messages/);
  });
});

describe("pricing", () => {
  it("prices text proportionally", () => {
    assert.ok(priceText("x".repeat(400)) > priceText("x".repeat(40)));
  });

  it("sums per-message prices", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "a".repeat(40) }], timestamp: 0 },
      { role: "user", content: [{ type: "text", text: "b".repeat(80) }], timestamp: 0 },
    ];
    assert.equal(priceMessages(messages), priceText("a".repeat(40)) + priceText("b".repeat(80)));
  });
});

describe("prefix fingerprints", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "second" }], timestamp: 0 },
  ];

  it("is stable across object key order", () => {
    const reordered = [{ timestamp: 0, content: [{ text: "first", type: "text" }], role: "user" }] as AgentMessage[];
    assert.equal(fingerprintMessages(reordered)[0], fingerprintMessages(messages.slice(0, 1))[0]);
  });

  it("counts the shared leading run", () => {
    const captured = fingerprintMessages(messages);
    assert.equal(sharedPrefixMessageCount(captured, fingerprintMessages(messages)), 2);
    assert.equal(
      sharedPrefixMessageCount(
        captured,
        fingerprintMessages([
          messages[0] as AgentMessage,
          { role: "user", content: [{ type: "text", text: "different" }], timestamp: 0 },
        ]),
      ),
      1,
    );
  });

  it("reports no sharing without a capture", () => {
    assert.equal(sharedPrefixMessageCount(undefined, fingerprintMessages(messages)), 0);
  });
});

describe("RequestCaptureStore", () => {
  it("stores per session and clears on demand", () => {
    const store = new RequestCaptureStore();
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }];
    store.capture("s1", "deepseek/m", messages);
    store.capture("s2", "deepseek/m", messages);
    assert.equal(store.get("s1")?.modelKey, "deepseek/m");
    store.clear("s1");
    assert.equal(store.get("s1"), undefined);
    assert.ok(store.get("s2") !== undefined);
    store.clearAll();
    assert.equal(store.get("s2"), undefined);
  });
});
