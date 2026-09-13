/**
 * Unit tests for configuration loading and fallbacks.
 * @module pi-deepseek-compaction/tests/unit/config
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadConfig } from "../../src/config.ts";

const roots: string[] = [];

function scaffold(globalConfig?: unknown, projectConfig?: unknown): { agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "dsk-compaction-config-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (globalConfig !== undefined) {
    writeFileSync(join(agentDir, "deepseek-compaction.json"), JSON.stringify(globalConfig));
  }
  if (projectConfig !== undefined) {
    writeFileSync(join(cwd, ".pi", "deepseek-compaction.json"), JSON.stringify(projectConfig));
  }
  return { agentDir, cwd };
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns documented defaults without any files", () => {
    const { agentDir, cwd } = scaffold();
    const resolution = loadConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });
    assert.deepEqual(resolution.config, {
      compaction: { model: "", thinkingLevel: "", maxTokens: 0, cacheRetention: "none" },
      fileLists: true,
      notify: "off",
      dryRun: false,
    });
    assert.equal(resolution.globalFound, false);
    assert.equal(resolution.projectFound, false);
    assert.deepEqual(resolution.problems, []);
  });

  it("lets the project file override the global file", () => {
    const { agentDir, cwd } = scaffold(
      { compaction: { model: "global-model", maxTokens: 4096 }, notify: "summary" },
      { compaction: { model: "project-model" } },
    );
    const { config } = loadConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });
    assert.equal(config.compaction.model, "project-model");
    assert.equal(config.compaction.maxTokens, 4096);
    assert.equal(config.notify, "summary");
  });

  it("lets environment variables override both files", () => {
    const { agentDir, cwd } = scaffold({ compaction: { model: "file-model" } });
    const { config } = loadConfig(cwd, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_DEEPSEEK_COMPACTION_MODEL: "env-model",
      PI_DEEPSEEK_COMPACTION_MAX_TOKENS: "2048",
      PI_DEEPSEEK_COMPACTION_NOTIFY: "diagnostic",
      PI_DEEPSEEK_COMPACTION_THINKING_LEVEL: "off",
      PI_DEEPSEEK_COMPACTION_CACHE_RETENTION: "long",
      PI_DEEPSEEK_COMPACTION_DRYRUN: "1",
    });
    assert.equal(config.compaction.model, "env-model");
    assert.equal(config.compaction.maxTokens, 2048);
    assert.equal(config.compaction.thinkingLevel, "off");
    assert.equal(config.compaction.cacheRetention, "long");
    assert.equal(config.notify, "diagnostic");
    assert.equal(config.dryRun, true);
  });

  it("falls back to defaults and records a problem for invalid values", () => {
    const { agentDir, cwd } = scaffold({
      compaction: { maxTokens: -5, cacheRetention: "forever" },
      notify: "verbose",
      dryRun: "maybe",
    });
    const resolution = loadConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });
    assert.equal(resolution.config.compaction.maxTokens, 0);
    assert.equal(resolution.config.compaction.cacheRetention, "none");
    assert.equal(resolution.config.notify, "off");
    assert.equal(resolution.config.dryRun, false);
    assert.equal(resolution.problems.length, 4);
    assert.match(resolution.problems[0] ?? "", /invalid value/);
  });

  it("accepts an explicitly empty model or thinking level as 'use the session default'", () => {
    const { agentDir, cwd } = scaffold({ compaction: { model: "", thinkingLevel: "" } });
    const resolution = loadConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });
    assert.equal(resolution.config.compaction.model, "");
    assert.equal(resolution.config.compaction.thinkingLevel, "");
    assert.deepEqual(resolution.problems, []);
  });

  it("treats a malformed file as missing", () => {
    const { agentDir, cwd } = scaffold();
    writeFileSync(join(agentDir, "deepseek-compaction.json"), "{not json");
    const resolution = loadConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });
    assert.equal(resolution.globalFound, false);
    assert.deepEqual(resolution.problems, []);
    assert.equal(resolution.config.notify, "off");
  });

  it("ignores unknown fields without reporting a problem", () => {
    const { agentDir, cwd } = scaffold({ compaction: { unknown: 1 }, other: true });
    const resolution = loadConfig(cwd, { PI_CODING_AGENT_DIR: agentDir });
    assert.deepEqual(resolution.problems, []);
  });
});
