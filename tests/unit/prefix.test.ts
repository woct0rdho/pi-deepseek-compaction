/**
 * Unit tests for prefix rebuilding, tool collection, pricing, and fingerprints.
 * @module pi-deepseek-compaction/tests/unit/prefix
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RequestCaptureStore } from "../../src/capture.ts";
import {
  PrefixBuildError,
  buildPrefixMessages,
  collectActiveTools,
  fingerprintMessages,
  priceMessages,
  priceText,
  sharedPrefixMessageCount,
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
      model: "deepseek-v4-pro",
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
  } as SessionEntry;
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
  } as SessionEntry;
}

describe("buildPrefixMessages", () => {
  it("returns the leading messages before Pi's cut", () => {
    const entries = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "answer one"),
      userEntry("u2", "a1", "second"),
      assistantEntry("a2", "u2", "answer two"),
    ];
    const prefix = buildPrefixMessages(entries, "u2");
    assert.deepEqual(prefix.map(message => message.role), ["user", "assistant"]);
    assert.deepEqual(toLlmMessages(prefix).map(message => message.role), ["user", "assistant"]);
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
    const prefix = buildPrefixMessages(entries, "u3");
    assert.deepEqual(prefix.map(message => message.role), ["compactionSummary", "user", "assistant"]);
    const llm = toLlmMessages(prefix);
    assert.equal(llm.length, 3);
    const first = llm[0];
    assert.equal(first?.role, "user");
    assert.match(
      first?.role === "user" && typeof first.content === "string"
        ? first.content
        : JSON.stringify(first?.content),
      /PRIOR SUMMARY/,
    );
  });

  it("keeps the kept tail out of the prefix", () => {
    const entries = [
      userEntry("u1", null, "first"),
      assistantEntry("a1", "u1", "answer one"),
      userEntry("u2", "a1", "second"),
    ];
    const prefix = buildPrefixMessages(entries, "a1");
    assert.deepEqual(prefix.map(message => message.role), ["user"]);
  });

  it("rejects a cut that is absent from the context", () => {
    const entries = [userEntry("u1", null, "first"), assistantEntry("a1", "u1", "answer one")];
    assert.throws(() => buildPrefixMessages(entries, "missing"), PrefixBuildError);
  });

  it("rejects a cut that leaves nothing to summarize", () => {
    const entries = [userEntry("u1", null, "first")];
    assert.throws(() => buildPrefixMessages(entries, "u1"), PrefixBuildError);
  });
});

describe("collectActiveTools", () => {
  const source = {
    getAllTools: () => [
      { name: "read", description: "read a file", parameters: { type: "object" } },
      { name: "bash", description: "run a command", parameters: { type: "object" } },
      { name: "edit", description: "edit a file", parameters: { type: "object" } },
    ],
    getActiveTools: () => ["bash", "read"],
  } as never;

  it("keeps registration order and drops inactive tools", () => {
    const tools = collectActiveTools(source);
    assert.deepEqual(tools.map(tool => tool.name), ["read", "bash"]);
    assert.equal(tools[0]?.description, "read a file");
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
