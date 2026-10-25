// Client of the file-list filter service. Pi's lists are built from tool-call
// arguments, so a read, write, or edit of a file that was later deleted stays in
// the checkpoint forever (the lists accumulate across compactions). The
// file-list-filter extension owns the filesystem check. This module asks it
// which of the extracted paths still exist.
//
// The protocol is a `pi.events` request. `pi.events` is fire-and-forget, so the
// request carries a `reply` callback and the client waits for one answer:
//
//     channel: "file-list-filter/v1/existing"
//     request: { cwd: string, paths: string[], reply(kept: string[]): void }
//
// A compaction must never fail because of this integration. Before the first
// request the client makes sure a filter is actually loaded: the service
// announces itself on "file-list-filter/v1/available" (at load and whenever a
// caller emits "file-list-filter/v1/discover"), and a client that hears no
// announcement skips the request. Without that handshake a setup without the
// filter extension would wait out a deadline on every compaction - in `--print`
// mode long enough for Pi to dispose the session before the compaction is
// written. A present service that goes silent, a malformed reply, and an abort
// all resolve to `undefined` and leave Pi's lists untouched.

import type { FileListDetails } from "./types.ts";

export const EXISTING_PATHS_CHANNEL = "file-list-filter/v1/existing";
export const AVAILABLE_CHANNEL = "file-list-filter/v1/available";
export const DISCOVER_CHANNEL = "file-list-filter/v1/discover";

// The responder only probes the filesystem, so a loaded filter answers in
// single-digit milliseconds. The deadline covers a service that announced
// itself and then went silent (a hung or broken responder).
export const EXISTING_PATHS_TIMEOUT_MS = 400;

export interface ExistingPathsRequest {
  cwd: string;
  paths: readonly string[];
  reply: (kept: readonly string[]) => void;
}

// The part of `pi.events` used here, kept structural so the client is trivial to
// test and does not depend on the host's event-bus declaration.
export interface EventBusLike {
  emit(channel: string, data: unknown): void;
}

export interface ObservableEventBusLike extends EventBusLike {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface RequestExistingPathsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FilteredLists {
  lists: FileListDetails;
  dropped: string[];
}

export interface FileListFilterStatus {
  // True when no service announced itself, or an announced one went unanswered.
  // Later requests are skipped.
  unavailable: boolean;
  // The last answered request.
  last?: { at: number; checked: number; dropped: number };
}

function normalizeReply(value: unknown, requested: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // A reply with non-string entries is malformed. Treat it as no answer so a
  // broken responder cannot erase every path at once.
  if (value.some(item => typeof item !== "string")) return undefined;
  const allowed = new Set(requested);
  return value.filter((item): item is string => allowed.has(item));
}

// Ask loaded filter extensions which of `paths` exist.
//
// Resolves with the kept subset, or `undefined` when nobody answered (not
// loaded, malformed, timed out, or aborted). `paths` must be the exact strings
// the caller wants echoed back. The reply is filtered against them.
export function requestExistingPaths(
  events: EventBusLike,
  cwd: string,
  paths: readonly string[],
  options: RequestExistingPathsOptions = {},
): Promise<readonly string[] | undefined> {
  if (paths.length === 0) return Promise.resolve<readonly string[] | undefined>([]);
  const { signal } = options;
  if (signal?.aborted === true) return Promise.resolve(undefined);
  const timeoutMs = options.timeoutMs ?? EXISTING_PATHS_TIMEOUT_MS;
  return new Promise<readonly string[] | undefined>(resolvePromise => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: readonly string[] | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };
    const onAbort = (): void => finish(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(undefined), timeoutMs);
    // A pending probe must not keep the process alive.
    timer.unref?.();
    try {
      const request: ExistingPathsRequest = {
        cwd,
        paths,
        reply: kept => finish(normalizeReply(kept, paths)),
      };
      events.emit(EXISTING_PATHS_CHANNEL, request);
    } catch {
      finish(undefined);
    }
  });
}

// Apply a kept-path subset to Pi's two lists, preserving their order.
export function keepExisting(lists: FileListDetails, kept: readonly string[] | undefined): FilteredLists {
  if (kept === undefined) return { lists, dropped: [] };
  const keep = new Set(kept);
  const readFiles = lists.readFiles.filter(path => keep.has(path));
  const modifiedFiles = lists.modifiedFiles.filter(path => keep.has(path));
  const dropped = [...lists.readFiles, ...lists.modifiedFiles].filter(path => !keep.has(path));
  return { lists: { readFiles, modifiedFiles }, dropped };
}

// Per-process state for the service: whether a filter announced itself, the
// last answered check, and whether the service is known to be absent.
export class ExistingPathsClient {
  readonly status: FileListFilterStatus = { unavailable: false };
  // Set by the service's announcement, at load or on a discover request.
  private announced = false;

  // Subscribe to the service's announcements. Call once, at extension load,
  // before the first compaction.
  watch(events: ObservableEventBusLike): void {
    events.on(AVAILABLE_CHANNEL, () => {
      this.announced = true;
    });
  }

  // Filter one compaction's lists. Never rejects.
  async filter(
    events: EventBusLike,
    cwd: string,
    lists: FileListDetails,
    options: RequestExistingPathsOptions = {},
  ): Promise<FilteredLists> {
    const candidates = [...lists.readFiles, ...lists.modifiedFiles];
    if (this.status.unavailable || candidates.length === 0) return { lists, dropped: [] };
    if (!this.announced) {
      // Asks a loaded service that announced before this client could listen.
      // The service's reply is synchronous, so this costs no waiting. A false
      // result means there is nothing to ask.
      events.emit(DISCOVER_CHANNEL, {});
      if (!this.announced) {
        this.status.unavailable = true;
        return { lists, dropped: [] };
      }
    }
    const kept = await requestExistingPaths(events, cwd, candidates, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (kept === undefined) {
      // An announced service that never answered. Keep Pi's lists and stop
      // asking, so a broken filter costs one deadline per process. An aborted
      // compaction says nothing about the service, so it stays available.
      if (options.signal?.aborted !== true) this.status.unavailable = true;
      return { lists, dropped: [] };
    }
    const filtered = keepExisting(lists, kept);
    this.status.last = {
      at: Date.now(),
      checked: candidates.length,
      dropped: filtered.dropped.length,
    };
    return filtered;
  }
}
