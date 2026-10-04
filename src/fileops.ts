// File-operation tracking kept from Pi's default compactor: the read and
// modified lists are extracted from tool calls, accumulated across compactions,
// and appended to the summary as `<read-files>` / `<modified-files>` blocks.

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FileListDetails } from "./types.ts";

export interface FileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export function createFileOps(): FileOps {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

interface ToolCallBlock {
  type: "toolCall";
  name?: unknown;
  arguments?: unknown;
}

function toolCallPath(block: unknown): { name: string; path: string } | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const candidate = block as ToolCallBlock;
  if (candidate.type !== "toolCall" || typeof candidate.name !== "string") return undefined;
  const args = candidate.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? { name: candidate.name, path } : undefined;
}

export function extractFileOpsFromMessages(messages: readonly AgentMessage[], ops: FileOps): void {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const content = "content" in message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      const call = toolCallPath(block);
      if (call === undefined) continue;
      if (call.name === "read") ops.read.add(call.path);
      else if (call.name === "write") ops.written.add(call.path);
      else if (call.name === "edit") ops.edited.add(call.path);
    }
  }
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Accumulate file lists recorded by earlier compactions. This extension's own
// details are read first because Pi skips extension-provided details when it
// accumulates its own lists. Pi's plain `{ readFiles, modifiedFiles }` shape is
// still honored for sessions compacted before this extension was mounted, and a
// nested copy under `dshCompaction` is accepted as well.
export function collectPreviousFileOps(branchEntries: readonly SessionEntry[], ops: FileOps): void {
  for (const entry of branchEntries) {
    if (entry.type !== "compaction") continue;
    const details = entry.details;
    if (typeof details !== "object" || details === null) continue;
    const record = details as Record<string, unknown>;
    const nested = typeof record.dshCompaction === "object" && record.dshCompaction !== null
      ? (record.dshCompaction as Record<string, unknown>)
      : {};
    for (const path of [...stringsOf(record.readFiles), ...stringsOf(nested.readFiles)]) ops.read.add(path);
    for (const path of [...stringsOf(record.modifiedFiles), ...stringsOf(nested.modifiedFiles)]) {
      ops.edited.add(path);
    }
  }
}

export function computeFileLists(ops: FileOps): FileListDetails {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readOnly = [...ops.read].filter(path => !modified.has(path)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

export function formatFileOperations(lists: FileListDetails): string {
  const sections: string[] = [];
  if (lists.readFiles.length > 0) {
    sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
  }
  if (lists.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}
