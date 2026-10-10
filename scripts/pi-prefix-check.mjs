// End-to-end prefix check: runs Pi (1.0.x) against a local mock provider,
// forces a compaction, and asserts that the summarize request reproduces the
// real request's wire prefix byte for byte - including across a mid-session tool
// loadout change, which also makes Pi append a prompt section patch and a tool
// declaration.
//
// Offline: the mock answers every request, so nothing is billed. Requires `pi`
// on PATH. Run with `npm run test:e2e`. It is not part of `npm test` because it
// depends on an installed Pi.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "pi-deepseek-compaction-e2e-"));
const requests = [];
let failures = 0;

const LONG = Array.from(
  { length: 150 },
  (_, i) => `record ${i}: the durable session log stays authoritative while derived caches remain optional.`,
).join(" ");
const SHORT = Array.from(
  { length: 12 },
  (_, i) => `summary line ${i}: the durable log stays authoritative; derived caches remain optional.`,
).join(" ");

function sse(text) {
  const chunk = (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock-1",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  return chunk({ role: "assistant", content: "" }, null)
    + chunk({ content: text }, null)
    + chunk({}, "stop", {
      prompt_tokens: 100,
      completion_tokens: 2,
      total_tokens: 102,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 100,
    })
    + "data: [DONE]\n\n";
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", data => {
    body += data.toString("utf8");
  });
  request.on("end", () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    const isSummarize = body.includes("compaction engine");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(isSummarize ? SHORT : LONG));
  });
});

const fingerprint = value => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 10);
const CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
// The request shape a provider keys its prompt cache on: every field except the
// message list and the output cap the summarize call sizes for itself.
const shape = payload => Object.fromEntries(
  Object.entries(payload).filter(([key]) => key !== "messages" && !CAP_FIELDS.includes(key)),
);
const isSummarize = payload => {
  const messages = payload.messages ?? [];
  return messages.length > 0 && JSON.stringify(messages.at(-1)).includes("compaction engine");
};

function check() {
  const summarize = requests.filter(isSummarize);
  const real = requests.filter(payload => !isSummarize(payload));
  console.log(`e2e: ${requests.length} requests (${real.length} real, ${summarize.length} summarize)`);
  if (summarize.length === 0) {
    console.error("e2e: no summarize request was captured");
    failures += 1;
    return;
  }
  for (const call of summarize) {
    const index = requests.indexOf(call);
    const prior = real.filter(payload => requests.indexOf(payload) < index).at(-1);
    if (prior === undefined) continue;
    const summarizeMessages = call.messages ?? [];
    const realMessages = prior.messages ?? [];
    let shared = 0;
    while (
      shared < Math.min(summarizeMessages.length, realMessages.length)
      && fingerprint(summarizeMessages[shared]) === fingerprint(realMessages[shared])
    ) shared += 1;
    const prefixOk = shared === summarizeMessages.length - 1 && shared <= realMessages.length;
    const toolsOk = fingerprint(call.tools) === fingerprint(prior.tools);
    const optionsOk = fingerprint(shape(call)) === fingerprint(shape(prior));
    const toolNames = (call.tools ?? []).map(tool => tool.function?.name);
    console.log(
      `e2e: summarize #${index} vs real #${requests.indexOf(prior)}:`
        + ` shared ${shared}/${summarizeMessages.length - 1} prefix messages, prefix_ok=${prefixOk},`
        + ` tools_ok=${toolsOk}, options_ok=${optionsOk}, tools=[${toolNames.join(", ")}]`,
    );
    if (!optionsOk) {
      const keys = new Set([...Object.keys(shape(call)), ...Object.keys(shape(prior))]);
      const differing = [...keys].filter(key => fingerprint(shape(call)[key]) !== fingerprint(shape(prior)[key]));
      console.log(`e2e:   request shape differs in: ${differing.join(", ")} (a provider would cache these separately)`);
    }
    if (!prefixOk || !toolsOk || !optionsOk) failures += 1;
  }
  const toolSets = new Set(requests.map(payload => JSON.stringify((payload.tools ?? []).map(t => t.function?.name))));
  if (toolSets.size < 2) {
    console.warn("e2e: warning: the tool loadout never changed, so the mid-session case was not exercised");
  } else {
    console.log(`e2e: observed ${toolSets.size} distinct tool loadouts across the run`);
  }
}

process.on("exit", () => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/v1`;

const project = join(work, "project");
mkdirSync(join(project, ".pi"), { recursive: true });
mkdirSync(join(project, "sessions"), { recursive: true });
writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
  compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 200 },
}));
writeFileSync(join(project, ".pi", "deepseek-compaction.json"), JSON.stringify({
  compaction: { maxTokens: 1024, thinkingLevel: "off" },
  notify: "diagnostic",
}));

writeFileSync(join(work, "probe.ts"), `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
  pi.registerProvider("probe", {
    name: "Probe",
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: "test",
    api: "openai-completions",
    models: [{
      id: "mock-1",
      name: "Mock 1",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 2048,
    }],
  });

  // Force a mid-session prompt patch and tool loadout change on the second turn.
  let turn = 0;
  pi.on("turn_start", () => {
    turn += 1;
    if (turn === 2) pi.setActiveTools([...new Set([...pi.getActiveTools(), "grep"])]);
  });
}
`);

const child = spawn(
  "pi",
  [
    "-ne",
    "-e", join(work, "probe.ts"),
    "-e", join(repoRoot, "src", "index.ts"),
    "--provider", "probe",
    "--model", "mock-1",
    "-a",
    "--session-dir", join(project, "sessions"),
    "--print",
    "First request: remember ORANGE.",
    "Second request: keep going.",
    "Third request: what word?",
  ],
  { cwd: project, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", data => {
  stdout += data.toString("utf8");
});
child.stderr.on("data", data => {
  stderr += data.toString("utf8");
});
const status = await new Promise(resolveExit => {
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    resolveExit("timeout");
  }, 180_000);
  child.on("exit", code => {
    clearTimeout(timer);
    resolveExit(code);
  });
});
if (status !== 0) {
  console.error(`e2e: pi exited ${status}`);
  console.error(stdout.slice(-2000));
  console.error(stderr.slice(-2000));
  failures += 1;
} else {
  console.log(stderr.trim().split("\n").filter(line => line.includes("deepseek-compaction")).join("\n"));
}

check();
if (failures > 0) {
  console.error(`e2e: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("e2e: ok");
// The mock server keeps the event loop alive, so close it (including any
// keep-alive sockets Pi left behind) before exiting.
server.closeAllConnections();
server.close();
