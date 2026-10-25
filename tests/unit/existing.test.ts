import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AVAILABLE_CHANNEL,
  DISCOVER_CHANNEL,
  EXISTING_PATHS_CHANNEL,
  EXISTING_PATHS_TIMEOUT_MS,
  ExistingPathsClient,
  keepExisting,
  requestExistingPaths,
  type EventBusLike,
  type ExistingPathsRequest,
  type ObservableEventBusLike,
} from "../../src/existing.ts";

interface FakeBus extends ObservableEventBusLike {
  channels: string[];
}

// A bus that behaves like the file-list-filter extension: it answers the
// announcement handshake when `announced` is set, and it always answers path
// requests from a fixed set of "existing" paths.
function fakeBus(options: { announced?: boolean; existing?: readonly string[] } = {}): FakeBus {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const channels: string[] = [];
  const found = new Set(options.existing ?? []);
  const bus: FakeBus = {
    channels,
    emit(channel, data) {
      channels.push(channel);
      for (const listener of listeners.get(channel) ?? []) listener(data);
      if (channel === DISCOVER_CHANNEL && options.announced === true) {
        bus.emit(AVAILABLE_CHANNEL, { version: 1 });
      }
      if (channel === EXISTING_PATHS_CHANNEL) {
        const request = data as ExistingPathsRequest;
        request.reply(request.paths.filter(path => found.has(path)));
      }
    },
    on(channel, handler) {
      const list = listeners.get(channel) ?? [];
      list.push(handler);
      listeners.set(channel, list);
      return () => {};
    },
  };
  return bus;
}

// A bus nobody subscribes to. `pi.events` never reports whether a channel has
// listeners, so the handshake is what keeps an absent filter from costing time.
const silentBus: EventBusLike = { emit() {} };

// Announces, but never answers the path request.
function silentAfterAnnouncing(): FakeBus {
  const bus = fakeBus({ announced: true });
  const emit = bus.emit.bind(bus);
  bus.emit = (channel, data) => {
    if (channel === EXISTING_PATHS_CHANNEL) return;
    emit(channel, data);
  };
  return bus;
}

describe("requestExistingPaths", () => {
  it("returns the answered subset and passes the cwd through", async () => {
    const bus = fakeBus({ existing: ["src/a.ts", "src/c.ts"] });
    const kept = await requestExistingPaths(bus, "/project", ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.deepEqual(kept, ["src/a.ts", "src/c.ts"]);
    assert.deepEqual(bus.channels, [EXISTING_PATHS_CHANNEL]);
  });

  it("never returns a path the caller did not ask about", async () => {
    const bus: EventBusLike = {
      emit(_channel, data) {
        (data as ExistingPathsRequest).reply(["src/a.ts", "elsewhere.ts"]);
      },
    };
    assert.deepEqual(await requestExistingPaths(bus, "/p", ["src/a.ts"]), ["src/a.ts"]);
  });

  it("treats a malformed reply as no answer", async () => {
    for (const reply of [() => ({}), () => null, () => "src/a.ts", () => [1, 2]]) {
      const bus: EventBusLike = { emit: (_channel, data) => (data as { reply(v: unknown): void }).reply(reply()) };
      assert.equal(await requestExistingPaths(bus, "/p", ["src/a.ts"], { timeoutMs: 20 }), undefined);
    }
  });

  it("resolves undefined when nobody answers", async () => {
    assert.equal(await requestExistingPaths(silentBus, "/p", ["src/a.ts"], { timeoutMs: 20 }), undefined);
  });

  it("ignores every answer after the first and never resolves twice", async () => {
    let calls = 0;
    const bus: EventBusLike = {
      emit(_channel, data) {
        const { reply } = data as ExistingPathsRequest;
        reply(["a.ts"]);
        reply(["a.ts", "b.ts"]);
        calls += 1;
      },
    };
    assert.deepEqual(await requestExistingPaths(bus, "/p", ["a.ts", "b.ts"], { timeoutMs: 20 }), ["a.ts"]);
    assert.equal(calls, 1);
  });

  it("skips the request for an empty list and for an aborted signal", async () => {
    let emitted = 0;
    const bus: EventBusLike = { emit: () => void (emitted += 1) };
    assert.deepEqual(await requestExistingPaths(bus, "/p", []), []);
    const controller = new AbortController();
    controller.abort();
    assert.equal(await requestExistingPaths(bus, "/p", ["a.ts"], { signal: controller.signal }), undefined);
    assert.equal(emitted, 0);
  });

  it("resolves undefined when the caller aborts while waiting", async () => {
    const controller = new AbortController();
    const pending = requestExistingPaths(silentBus, "/p", ["a.ts"], { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    assert.equal(await pending, undefined);
  });

  it("treats a throwing bus as no answer", async () => {
    const bus: EventBusLike = {
      emit() {
        throw new Error("bus is gone");
      },
    };
    assert.equal(await requestExistingPaths(bus, "/p", ["a.ts"]), undefined);
  });

  it("uses a budget short enough for an ordinary compaction", () => {
    assert.ok(EXISTING_PATHS_TIMEOUT_MS > 0 && EXISTING_PATHS_TIMEOUT_MS <= 1_000);
  });
});

describe("keepExisting", () => {
  it("keeps the order of both lists and reports only removed paths", () => {
    const result = keepExisting(
      { readFiles: ["b.ts", "gone.ts", "a.ts"], modifiedFiles: ["lost/c.ts", "d.ts"] },
      ["a.ts", "b.ts", "d.ts"],
    );
    assert.deepEqual(result.lists, { readFiles: ["b.ts", "a.ts"], modifiedFiles: ["d.ts"] });
    assert.deepEqual(result.dropped, ["gone.ts", "lost/c.ts"]);
  });

  it("passes the lists through when there is no answer", () => {
    const lists = { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] };
    assert.deepEqual(keepExisting(lists, undefined), { lists, dropped: [] });
  });
});

describe("ExistingPathsClient", () => {
  it("filters a compaction's lists and records the check", async () => {
    const bus = fakeBus({ existing: ["a.ts"] });
    const client = new ExistingPathsClient();
    client.watch(bus);
    bus.emit(AVAILABLE_CHANNEL, { version: 1 });
    const result = await client.filter(bus, "/p", { readFiles: ["b.ts", "a.ts"], modifiedFiles: ["c.ts"] });
    assert.deepEqual(result.lists, { readFiles: ["a.ts"], modifiedFiles: [] });
    assert.deepEqual(result.dropped, ["b.ts", "c.ts"]);
    assert.equal(client.status.unavailable, false);
    assert.equal(client.status.last?.checked, 3);
    assert.equal(client.status.last?.dropped, 2);
  });

  it("finds a service that announced before the client listened", async () => {
    const bus = fakeBus({ announced: true, existing: ["a.ts"] });
    const client = new ExistingPathsClient();
    client.watch(bus);
    const result = await client.filter(bus, "/p", { readFiles: ["a.ts", "gone.ts"], modifiedFiles: [] });
    assert.deepEqual(result.dropped, ["gone.ts"]);
    assert.deepEqual(bus.channels, [DISCOVER_CHANNEL, AVAILABLE_CHANNEL, EXISTING_PATHS_CHANNEL]);
  });

  it("skips the request when no service announces itself", async () => {
    const bus = fakeBus({ existing: ["a.ts"] });
    const client = new ExistingPathsClient();
    client.watch(bus);
    const lists = { readFiles: ["a.ts", "gone.ts"], modifiedFiles: [] };
    const result = await client.filter(bus, "/p", lists);
    assert.deepEqual(result, { lists, dropped: [] });
    assert.equal(client.status.unavailable, true);
    assert.equal(client.status.last, undefined);
    // One discovery attempt, no path request, and therefore no deadline wait.
    assert.deepEqual(bus.channels, [DISCOVER_CHANNEL]);
  });

  it("stops asking after an announced service fails to answer", async () => {
    const bus = silentAfterAnnouncing();
    const client = new ExistingPathsClient();
    client.watch(bus);
    bus.emit(AVAILABLE_CHANNEL, { version: 1 });
    const lists = { readFiles: ["a.ts"], modifiedFiles: [] };
    assert.deepEqual(await client.filter(bus, "/p", lists, { timeoutMs: 20 }), { lists, dropped: [] });
    assert.equal(client.status.unavailable, true);
    assert.equal(client.status.last, undefined);

    let emitted = 0;
    const counting: EventBusLike = { emit: () => void (emitted += 1) };
    assert.deepEqual(await client.filter(counting, "/p", lists), { lists, dropped: [] });
    assert.equal(emitted, 0);
  });

  it("does not ask about empty lists", async () => {
    const client = new ExistingPathsClient();
    let emitted = 0;
    const empty = { readFiles: [], modifiedFiles: [] };
    const bus: FakeBus = {
      channels: [],
      emit: () => void (emitted += 1),
      on: () => () => {},
    };
    assert.deepEqual(await client.filter(bus, "/p", empty), { lists: empty, dropped: [] });
    assert.equal(emitted, 0);
    assert.equal(client.status.last, undefined);
  });

  it("keeps the lists when the compaction is aborted and keeps the service available", async () => {
    const bus = fakeBus({ existing: ["a.ts"] });
    const client = new ExistingPathsClient();
    client.watch(bus);
    bus.emit(AVAILABLE_CHANNEL, { version: 1 });
    const controller = new AbortController();
    controller.abort();
    const lists = { readFiles: ["a.ts"], modifiedFiles: [] };
    assert.deepEqual(await client.filter(bus, "/p", lists, { signal: controller.signal }), { lists, dropped: [] });
    assert.equal(client.status.unavailable, false);
    assert.equal(client.status.last, undefined);
  });
});
