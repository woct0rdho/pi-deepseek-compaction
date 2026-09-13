/**
 * Unit tests for file-operation tracking.
 * @module pi-deepseek-compaction/tests/unit/fileops
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  collectPreviousFileOps,
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessages,
  formatFileOperations,
} from "../../src/fileops.ts";

function assistantWithCalls(calls: Array<{ name: string; path: string }>): AgentMessage {
  return {
    role: "assistant",
    content: calls.map((call, index) => ({
      type: "toolCall" as const,
      id: `call-${index}`,
      name: call.name,
      arguments: { path: call.path },
    })),
    api: "openai-completions",
    provider: "deepseek",
    model: "m",
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
  } as AgentMessage;
}

function compactionEntry(id: string, details: unknown): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    summary: "s",
    firstKeptEntryId: "x",
    tokensBefore: 1,
    details,
  } as SessionEntry;
}

describe("extractFileOpsFromMessages", () => {
  it("records read, write, and edit paths and ignores other tools", () => {
    const ops = createFileOps();
    extractFileOpsFromMessages(
      [
        assistantWithCalls([
          { name: "read", path: "src/a.ts" },
          { name: "write", path: "src/b.ts" },
          { name: "edit", path: "src/c.ts" },
          { name: "bash", path: "src/d.ts" },
        ]),
      ],
      ops,
    );
    assert.deepEqual([...ops.read], ["src/a.ts"]);
    assert.deepEqual([...ops.written], ["src/b.ts"]);
    assert.deepEqual([...ops.edited], ["src/c.ts"]);
  });
});

describe("collectPreviousFileOps", () => {
  it("reads this extension's nested details and Pi's flat details", () => {
    const ops = createFileOps();
    collectPreviousFileOps(
      [
        compactionEntry("c1", { dshCompaction: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] } }),
        compactionEntry("c2", { readFiles: ["c.ts"], modifiedFiles: ["d.ts"] }),
        compactionEntry("c3", undefined),
      ],
      ops,
    );
    assert.deepEqual([...ops.read].sort(), ["a.ts", "c.ts"]);
    assert.deepEqual([...ops.edited].sort(), ["b.ts", "d.ts"]);
  });

  it("reads the flat lists this extension writes next to its own details object", () => {
    const ops = createFileOps();
    collectPreviousFileOps(
      [compactionEntry("c1", { readFiles: ["kept.ts"], modifiedFiles: [], dshCompaction: { version: 1 } })],
      ops,
    );
    assert.deepEqual([...ops.read], ["kept.ts"]);
  });
});

describe("computeFileLists", () => {
  it("excludes modified files from the read-only list and sorts both", () => {
    const ops = createFileOps();
    for (const path of ["z.ts", "a.ts", "m.ts"]) ops.read.add(path);
    ops.edited.add("m.ts");
    ops.written.add("b.ts");
    assert.deepEqual(computeFileLists(ops), {
      readFiles: ["a.ts", "z.ts"],
      modifiedFiles: ["b.ts", "m.ts"],
    });
  });
});

describe("formatFileOperations", () => {
  it("returns an empty string when both lists are empty", () => {
    assert.equal(formatFileOperations({ readFiles: [], modifiedFiles: [] }), "");
  });

  it("formats both blocks in Pi's layout", () => {
    const text = formatFileOperations({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
    assert.equal(text, "\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>");
  });

  it("formats a single block when only one list is populated", () => {
    assert.equal(formatFileOperations({ readFiles: [], modifiedFiles: ["b.ts"] }), "\n\n<modified-files>\nb.ts\n</modified-files>");
  });
});
