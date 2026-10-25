// End-to-end check for the file-list filter integration.
//
// Four runs against a local mock provider, each one prompting for two `read`
// calls and deleting one of the files right after its read finished:
// - Pi's built-in compactor + file-list-filter   -> the deleted path is gone
// - Pi's built-in compactor alone (control)      -> the deleted path is kept
// - pi-deepseek-compaction + file-list-filter    -> gone, and recorded in
//                                                   dshCompaction.droppedFiles
// - pi-deepseek-compaction alone (control)       -> kept
//
// The controls prove the deletion really happens before the compaction, so the
// absence in 1 and 3 comes from the filter and not from the transcript.
//
// Offline: the mock answers every request, so nothing is billed. Needs `pi` on
// PATH and the personal file-list-filter extension, which is skipped when
// absent. Run with `npm run test:e2e:filelists`.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deepseekExtension = join(repoRoot, "src", "index.ts");
const filterExtension =
  process.env.PI_FILE_LIST_FILTER_EXT ?? join(homedir(), ".pi", "agent", "extensions", "file-list-filter.ts");

if (!existsSync(filterExtension)) {
  console.log(`e2e: skipped (file-list-filter extension not found at ${filterExtension})`);
  process.exit(0);
}

const isWindows = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "pi-file-list-e2e-"));
const LONG = Array.from(
  { length: 150 },
  (_, i) => `record ${i}: the durable session log stays authoritative while derived caches remain optional.`,
).join(" ");
// Small enough that pi-deepseek-compaction accepts it as "smaller than the
// history it replaces".
const SHORT = "ok";
const PATHS = ["src/live.ts", "src/doomed.ts"];

let requests = [];

function chunk(delta, finish, usage) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-1",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage === undefined ? {} : { usage }),
  })}\n\n`;
}

function textSse(text) {
  return chunk({ role: "assistant", content: "" }, null)
    + chunk({ content: text }, null)
    + chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 })
    + "data: [DONE]\n\n";
}

function toolCallSse(paths) {
  const calls = paths
    .map((path, index) =>
      chunk({
        tool_calls: [{
          index,
          id: `call_${index}`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path }) },
        }],
      }, null),
    )
    .join("");
  return chunk({ role: "assistant", content: null }, null)
    + calls
    + chunk({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 })
    + "data: [DONE]\n\n";
}

// Pi's default summarizer and pi-deepseek-compaction's instruction, respectively.
function isSummarize(body) {
  return body.includes("compaction engine") || body.includes("context summarization assistant");
}

const server = createServer((request, response) => {
  let body = "";
  request.on("data", data => {
    body += data.toString("utf8");
  });
  request.on("end", () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (isSummarize(body)) {
      response.end(textSse(SHORT));
      return;
    }
    const last = (payload.messages ?? []).at(-1) ?? {};
    response.end(last.role === "tool" ? textSse(LONG) : toolCallSse(PATHS));
  });
});

await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();

function probeSource() {
  return `
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function probe(pi: ExtensionAPI): void {
  pi.registerProvider("probe", {
    name: "Probe",
    baseUrl: "http://127.0.0.1:${port}/v1",
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

  // Both reads succeed while the files exist. The doomed one disappears before
  // Pi gets a chance to compact.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read") return;
    const path = typeof event.input.path === "string" ? event.input.path : "";
    if (!path.includes("doomed")) return;
    rmSync(isAbsolute(path) ? path : join(process.cwd(), path), { force: true });
  });
}
`;
}

function makeProject(name) {
  const dir = join(work, name);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "src", "live.ts"), "export const live = 1;\n");
  writeFileSync(join(dir, "src", "doomed.ts"), "export const doomed = 1;\n");
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({
    compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 200 },
  }));
  writeFileSync(join(work, `${name}-probe.ts`), probeSource());
  return dir;
}

function sessionJsonl(dir) {
  const found = [];
  const walk = path => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function compactionEntries(dir) {
  const entries = [];
  for (const file of sessionJsonl(join(dir, "sessions"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (entry.type === "compaction") entries.push(entry);
    }
  }
  return entries;
}

// `cmd.exe` joins the arguments itself, so quote what contains spaces.
const quote = value => (isWindows && /\s/.test(value) ? `"${value.replaceAll("\"", "\\\"")}"` : value);

async function runPi(name, extensions) {
  const dir = makeProject(name);
  const args = [
    "-ne",
    "-e", join(work, `${name}-probe.ts`),
    ...extensions.flatMap(path => ["-e", path]),
    "--provider", "probe",
    "--model", "mock-1",
    "-a",
    "--session-dir", join(dir, "sessions"),
    "--print",
    "Read both files.",
  ];
  const child = isWindows
    // cmd.exe needs one command line. Passing an args array with `shell: true`
    // is deprecated.
    ? spawn(["pi", ...args.map(quote)].join(" "), {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
    })
    : spawn("pi", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => void (stdout += data.toString("utf8")));
  child.stderr.on("data", data => void (stderr += data.toString("utf8")));
  const status = await new Promise(resolveExit => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolveExit("timeout");
    }, 120_000);
    child.on("error", error => {
      clearTimeout(timer);
      resolveExit(`spawn failed: ${error.message}`);
    });
    child.on("exit", code => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  return { status, stdout, stderr, dir, requests, entries: compactionEntries(dir) };
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok: ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL: ${label}${detail === undefined ? "" : ` (${detail})`}`);
}

function lastCompaction(label, run, requestCount) {
  console.log(`${label}: pi exited ${run.status}, ${requestCount} requests, ${run.entries.length} compaction entries`);
  if (run.status !== 0) {
    console.error(run.stdout.slice(-1500));
    console.error(run.stderr.slice(-1500));
    failures += 1;
    return undefined;
  }
  const entry = run.entries.at(-1);
  if (entry === undefined) {
    console.error(`  FAIL: no compaction entry in the session (${run.stderr.trim().split("\n").slice(-3).join(" | ")})`);
    failures += 1;
    return undefined;
  }
  const details = entry.details ?? {};
  const summary = entry.summary;
  console.log(`  summary: ${summary.split("\n").filter(line => line.trim() !== "").slice(-6).join(" / ")}`);
  return { entry, summary, details };
}

function expectFiltered(label, run, requestCount) {
  const result = lastCompaction(label, run, requestCount);
  if (result === undefined) return undefined;
  const readFiles = result.details.readFiles ?? [];
  check("deleted path is absent from the summary", !result.summary.includes("src/doomed.ts"));
  check("deleted path is absent from details.readFiles", !readFiles.includes("src/doomed.ts"));
  check("existing path is still in the summary", result.summary.includes("src/live.ts"));
  check("existing path is still in details.readFiles", readFiles.includes("src/live.ts"));
  return result;
}

function expectUnfiltered(label, run, requestCount) {
  const result = lastCompaction(label, run, requestCount);
  if (result === undefined) return;
  check("control: deleted path is still in the summary", result.summary.includes("src/doomed.ts"));
  check(
    "control: deleted path is still in details.readFiles",
    (result.details.readFiles ?? []).includes("src/doomed.ts"),
  );
}

process.on("exit", () => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

const runs = [
  ["built-in + filter", [filterExtension], expectFiltered],
  ["built-in control", [], expectUnfiltered],
  ["deepseek + filter", [filterExtension, deepseekExtension], expectFiltered],
  ["deepseek control", [deepseekExtension], expectUnfiltered],
];

for (const [label, extensions, inspect] of runs) {
  requests = [];
  const run = await runPi(label.replaceAll(/[^a-z0-9]+/gi, "-"), extensions);
  const result = inspect(label, run, requests.length);
  if (label === "deepseek + filter" && result !== undefined) {
    const dropped = result.details.dshCompaction?.droppedFiles ?? [];
    check("droppedFiles records the deleted path", dropped.includes("src/doomed.ts"), JSON.stringify(dropped));
  }
}

if (failures > 0) {
  console.error(`e2e: FAILED (${failures} check(s))`);
  process.exit(1);
}
console.log("e2e: ok");
server.closeAllConnections();
server.close();
