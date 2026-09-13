/**
 * Offline smoke test. Imports the extension's pure modules and checks the
 * documented defaults and formats. No provider is contacted and nothing is
 * billed; run with `npm run smoke`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessages,
  formatFileOperations,
} from "../src/fileops.ts";
import { COMPACTION_INSTRUCTION, buildInstructionMessage, framedSummaryText } from "../src/instruction.ts";
import { formatRatio } from "../src/status.ts";

const root = mkdtempSync(join(tmpdir(), "dsk-compaction-smoke-"));
try {
  const { config, problems } = loadConfig(root, {
    PI_CODING_AGENT_DIR: join(root, "agent"),
  });
  assert.deepEqual(problems, [], "a missing config produces no problems");
  assert.equal(config.compaction.cacheRetention, "none");
  assert.equal(config.compaction.model, "");
  assert.equal(config.notify, "off");
  assert.equal(config.fileLists, true);
  assert.equal(config.dryRun, false);

  for (const section of [
    "## Primary Request and Intent",
    "## Key Technical Concepts",
    "## Files and Code",
    "## Errors and Fixes",
    "## Pending Jobs",
    "## Current Work",
    "## Next Step",
    "## Critical Context",
  ]) {
    assert.ok(COMPACTION_INSTRUCTION.includes(section), `instruction carries ${section}`);
  }

  const plain = buildInstructionMessage();
  assert.equal(plain.role, "user");
  const focused = buildInstructionMessage("focus on the parser rewrite");
  assert.match(JSON.stringify(focused.content), /Additional focus/);

  const framed = framedSummaryText("BODY");
  assert.ok(framed.startsWith("The conversation history before this point was compacted"));
  assert.ok(framed.includes("<summary>\nBODY\n</summary>"));

  const ops = createFileOps();
  extractFileOpsFromMessages(
    [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "1", name: "read", arguments: { path: "src/index.ts" } },
          { type: "toolCall", id: "2", name: "edit", arguments: { path: "src/index.ts" } },
        ],
      },
    ],
    ops,
  );
  assert.deepEqual(computeFileLists(ops), { readFiles: [], modifiedFiles: ["src/index.ts"] });
  assert.equal(
    formatFileOperations({ readFiles: [], modifiedFiles: ["src/index.ts"] }),
    "\n\n<modified-files>\nsrc/index.ts\n</modified-files>",
  );

  assert.equal(formatRatio(9, 10), "0.90");
  assert.equal(formatRatio(0, 0), "n/a");

  console.log("smoke: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
