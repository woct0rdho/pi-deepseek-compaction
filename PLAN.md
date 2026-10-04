# pi-deepseek-compaction: design

`pi-deepseek-compaction` replaces how Pi produces a compaction summary. Pi keeps its trigger policy, `CompactionEntry`, `firstKeptEntryId`, `details`, `usage`, `/compact [instructions]`, and session/tree semantics. The extension only supplies the summary text and returns it from `session_before_compact`. Every failure cancels the compaction, so Pi's built-in compactor is never invoked as a fallback.

The package name mentions DeepSeek because that is the primary target, but the extension is provider-generic: it uses only Pi's session projection and Pi's provider stack, with no provider-specific protocol or endpoint.

Requires Pi 1.0 or newer. The extension uses `buildSessionProjection`, `pi.getSettings()`, the `context_with_system` hook, and `ModelRegistry.streamSimple`, and deliberately has no fallback path for older versions.

## Goal

The summarize request must be a byte prefix of a request the provider has already served, so the provider's prefix cache serves the input and the compaction is billed largely at the cache-read rate.

| Requirement | How it is met |
| --- | --- |
| The summarize request's system message, tool loadout, and leading messages match a prior real request | The request is Pi's own session projection, cut at Pi's compaction boundary, sent through the same adapter as a real turn |
| The provider serves the prefix from cache | The prefix is identical by construction. The status command measures the ratio instead of promising a rate |
| Successful compactions use Pi's normal data structures | An ordinary `compaction` entry with `summary`, `firstKeptEntryId`, `tokensBefore`, `usage`, and `details` |
| Failures leave the conversation untouched | Every failure path returns `{ cancel: true }`. No entry is written and Pi's compactor is never invoked |
| Normal turns are unaffected | The extension mutates no provider payload and no session entry. Its only effect is the hook's return value |

## Where it plugs in

| Hook | Use |
| --- | --- |
| `session_before_compact` | The extension's whole job: read `event.preparation`, `event.branchEntries`, `event.reason`, `event.customInstructions`, `event.signal`. Return `{ compaction }` or `{ cancel: true }` |
| `context_with_system` | Read-only capture of the transcript a real request is about to send, including system messages, for prefix-fidelity diagnostics |
| `session_start`, `session_shutdown`, `session_before_switch`, `session_before_fork`, `session_before_tree`, `session_compact` | Drop or rebuild in-memory capture state |
| `registerCommand` | `/deepseek-compaction`: resolved models, Pi's settings, the last compaction's ratio, the rolling ratio, and the last failure reason |

`session_before_compact` is reached from all three Pi compaction paths, so one handler covers them:
- threshold compaction (checked before a new prompt, after a tool batch, and after a run),
- overflow recovery (`reason: "overflow"`, `willRetry: true` when the aborted turn is retried),
- manual `/compact [instructions]` (`reason: "manual"`).

## The summarization request

The request is Pi's model-visible context, cut at Pi's compaction boundary, plus one instruction message:

```
[ projection entries before cut ]  ctx.sessionManager.buildSessionProjection(), sliced at firstKeptEntryId
[ user: compaction instruction ]   the only new tokens
```

Build steps:
- `ctx.sessionManager.buildSessionProjection()` returns Pi's canonical projection: the leading system message that declares the prompt and tool loadout, every later system-message patch and tool declaration, context edits applied, and the conversation in order.
- The cut is `projection.entries.findIndex(entry => entry.sourceEntry.id === preparation.firstKeptEntryId)`, which inherits Pi's cut semantics: turn boundaries, never cutting at a tool result, and split turns.
- `entries.slice(0, cut).flatMap(entry => entry.messages)` is converted with `convertToLlm`. System prompt state stays in the replayed prefix but is excluded from the summarized span, matching Pi's own `getMessagesFromProjectedEntryForCompaction`.
- The instruction is appended as the final user message and the whole context is sent through the host's provider stack.

```ts
const projection = ctx.sessionManager.buildSessionProjection();
const slice = sliceProjection(projection, event.preparation.firstKeptEntryId);

const outcome = await runSummarizeCall({
  model,
  context: { messages: [...toLlmMessages(slice.messages), buildInstructionMessage(event.customInstructions)] },
  maxTokens,
  reasoning,
  cacheRetention,          // undefined keeps the retention a normal turn uses
  sessionId,               // same routing id as a normal turn
  signal: event.signal,
}, complete);              // ctx.modelRegistry.streamSimple(...).result()
```

No `systemPrompt` and no `tools` are passed, and that is what makes the prefix exact. pi-ai's adapters derive the wire system prompt from the transcript's system messages (`resolveTranscript`) and the wire tool loadout from the transcript's tool declarations (`resolveTranscriptTools` → `getCurrentTools`), and the transcript persists full tool definitions in `toolsAdded`. Supplying only the projected messages therefore reproduces a real request's bytes by construction, with no reconstruction of the prompt or the tool schemas anywhere in the extension.

The call also forwards the session id and leaves cache retention at its default, so cache-affinity routing and explicit cache markers land where a normal turn puts them.

### Prefix diagnostics

A read-only `context_with_system` handler fingerprints every message a real request is about to send, system messages included. That hook hands over the same agent-message representation the projection produces, so both sides are comparable. A converted provider payload is not message-by-message comparable. At compaction time the same fingerprints are computed over the replayed prefix, yielding `sharedPrefixMessages` and `sharedPrefixTokens`. A divergence never blocks the call. It means a partial cache miss and is reported in `details`, the status command, and diagnostic notifications.

## The instruction

`INSTRUCTION_VERSION` is recorded with every compaction so a stored summary can be traced to the prompt that produced it. `event.customInstructions` from `/compact <text>` is appended as an `Additional focus:` paragraph.

`toolChoice: "none"` is always sent. The instruction also forbids tool use, and a returned tool call fails validation.

## What we return to Pi

```ts
{
  compaction: {
    summary,                                   // model text plus the appended file-list blocks
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: response.usage,                     // Pi folds this into session stats
    details: {
      readFiles,
      modifiedFiles,
      dshCompaction: {
        version: 1,
        instructionVersion,
        modelKey,
        summarizationModelKey,                 // differs from modelKey when a separate model is configured
        maxTokens,
        thinkingLevel,
        cacheRetention,
        prefixMessages,
        prefixTokens,
        promptTokens,                          // provider-reported, when available
        sharedPrefixMessages,
        sharedPrefixTokens,
        cacheRead,
        cacheWrite,
        summaryTokens,
        shadowedTokens,
        reason,                                // "manual" | "threshold" | "overflow"
        customInstructionsUsed,
      },
    },
  },
}
```

Notes:
- Validation before returning: non-empty text, no tool calls, `stopReason !== "length"`, and the framed summary must be strictly smaller than the summarized span. A failure cancels instead of landing a non-shrinking or truncated checkpoint.
- Pi's cache-miss accounting resets at compaction entries, so the post-compaction turn is not counted as a self-inflicted miss.
- Pi skips `details` from extension-provided compactions when it accumulates file operations (`!prevCompaction.fromHook`), so cumulative file tracking reads our own `details` first and then Pi's flat `{ readFiles, modifiedFiles }` shape. Otherwise file history is lost on the second compaction.
- The summary is extension-provided, so this extension computes the file lists itself: tool calls in the summarized span plus the lists recorded by earlier compactions, written both as `readFiles`/`modifiedFiles` and inside `dshCompaction`.

## Status command and the rolling cache ratio

The status command answers one question: is the prefix actually being reused? Because `notify` defaults to `"off"`, it is the only place the cache statistics appear.

```text
deepseek-compaction: loaded (Pi-owned enablement, notify off)
Config: ~/.pi/agent/deepseek-compaction.json (found) + <project>/.pi/deepseek-compaction.json (missing)
Effective: model=(session) thinkingLevel=high maxTokens=0.8 x reserve cacheRetention=inherit fileLists=true dryRun=false
Session model: deepseek/deepseek-flash
Summarize model: deepseek/deepseek-flash (same model: prefix reuse expected)
Pi settings: reserve 16384, keepRecent 20000
Compactions by this extension: 2 (other compactions skipped: 0)
Last:    cacheRead 1152 / prefixTokens 1778 = 0.65   prefix fidelity 3/3 messages   (threshold, deepseek/deepseek-flash)
Rolling: cacheRead 2304 / prefixTokens 15976 = 0.14
Last failure: none
```

Definitions:
- Sources are `ctx.sessionManager.getEntries()` filtered to `entry.type === "compaction"` with `details.dshCompaction`, so the numbers survive resume, fork, and tree navigation.
- `prefixTokens` is a fold of Pi's exported `estimateTokens` over the messages the summarize call sent, system messages included. Pi exposes no estimator for an arbitrary message array, so no tokenizer and no per-provider pricing are involved. Tool schemas are excluded because Pi's estimator prices messages only, which understates the ratio slightly. The provider-reported prompt size is recorded as `promptTokens` for an exact cross-check. A ratio slightly above 1.0 is possible and is not clamped.
- `ratio` is `cacheRead / prefixTokens` for one compaction. The rolling figure is `sum(cacheRead) / sum(prefixTokens)` with the count, so one entry cannot masquerade as a trend.
- `prefix fidelity` is `sharedPrefixMessages / prefixMessages` for the last compaction. It separates the two failure modes: a low ratio with full fidelity means the provider did not cache, while a low fidelity means the prefix no longer matched the real request.
- Compactions made by Pi's default compactor or by another extension have no `details.dshCompaction`. They are counted as `other compactions skipped` and excluded from the ratio.
- The last failure reason is process-local, because failures write no session entry. It is cleared at `session_start` and by the next successful compaction.

## Configuration

Read from `~/.pi/agent/deepseek-compaction.json` and `<cwd>/.pi/deepseek-compaction.json` (project wins), with `PI_DEEPSEEK_COMPACTION_*` environment overrides:

```json
{
  "compaction": {
    "model": "",
    "thinkingLevel": "",
    "maxTokens": 0,
    "cacheRetention": "inherit"
  },
  "fileLists": true,
  "notify": "off",
  "dryRun": false
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `compaction.model` | `""` | Model id for the summarize call. Empty means the current session model, which is also the only value that can reuse the prefix cache. |
| `compaction.thinkingLevel` | `""` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Empty uses the session level. Validated against the resolved model's `thinkingLevelMap`. |
| `compaction.maxTokens` | `0` | Output cap. `0` means Pi's formula, `floor(0.8 * reserveTokens)`, clamped by `model.maxTokens`, where `reserveTokens` comes from the compaction preparation. |
| `compaction.cacheRetention` | `"inherit"` | `"inherit"` forwards nothing, so pi-ai applies exactly what a normal turn uses and explicit cache markers land in the same place. On automatic-cache providers such as DeepSeek it makes no wire difference. Set `"none"`, `"short"`, or `"long"` to override. |
| `fileLists` | `true` | Append and accumulate Pi's `<read-files>` / `<modified-files>` blocks and record them in `details`. |
| `notify` | `"off"` | `"off"`, `"summary"` (one line after each success), or `"diagnostic"` (also prefix fidelity and token counts). Failures always notify once as a warning. |
| `dryRun` | `false` | Build and report the request without calling the model. |

Environment overrides: `PI_DEEPSEEK_COMPACTION_MODEL`, `PI_DEEPSEEK_COMPACTION_THINKING_LEVEL`, `PI_DEEPSEEK_COMPACTION_MAX_TOKENS`, `PI_DEEPSEEK_COMPACTION_CACHE_RETENTION`, `PI_DEEPSEEK_COMPACTION_NOTIFY`, `PI_DEEPSEEK_COMPACTION_DRYRUN`.

There is no `enabled` flag: loading the extension is the switch (`packages` entry, `-e`, or `--no-extensions`). Resolution never throws and never blocks loading: a malformed file behaves like a missing file, an invalid value falls back to its default, and unknown fields are ignored. `/deepseek-compaction` prints the effective configuration and the files it read, so a silently ignored typo is discoverable. An unregistered `compaction.model` or an unsupported `compaction.thinkingLevel` is detected at first use, reported once per session with a warning, and then the compaction cancels.

Pi's `reserveTokens` and `keepRecentTokens` stay Pi's settings. Each compaction reads the values Pi passes through `preparation.settings`, so Pi remains the single owner of the thresholds.

## Model and thinking level resolution

- The session model is `ctx.model`. Without one, the compaction cancels with a clear reason.
- The summarization model is `compaction.model` when set, otherwise the session model. A configured id is resolved through `ctx.modelRegistry.find(sessionModel.provider, configuredId)`. An unregistered model cancels with a configuration error rather than substituting a model silently.
- Credentials and transport come from the host: the summarize call runs through `ctx.modelRegistry.streamSimple(...).result()`, the same path a normal turn uses, so configured providers, OAuth, proxies, and custom base URLs keep working.
- The thinking level is `compaction.thinkingLevel` when set, otherwise `pi.getThinkingLevel()`. It is validated against the model's `thinkingLevelMap`. An unsupported level cancels with a configuration error.

## Failure policy: cancel

Every failure path returns `{ cancel: true }`, so Pi's own compactor is never invoked:
- no current model, or a configured summarization model that cannot be resolved,
- invalid thinking level for the resolved model,
- the cut entry absent from the session projection, or a prefix with no conversation messages,
- a rejected or failed summarize request, including provider errors such as missing credentials,
- empty summary text, a tool call in the summary, or `stopReason === "length"`,
- a summary that is not strictly smaller than the summarized span,
- an aborted `event.signal`, which cancels so Pi reports a cancellation rather than a failure,
- `dryRun`, after reporting the planned request.

Because `{ cancel: true }` carries no message, the reason is surfaced through `ctx.ui.notify` as a warning, and kept in memory for the status command's `Last failure:` line. Failure notifications are not gated by `notify`, which only governs success chatter. No session entry is written for a failure, and no entry is written for a success beyond the ordinary `CompactionEntry`. Pi's own runtime events (`compaction_end`, `session_compact_failed`) still fire.

What cancelling means per trigger:
- Threshold compaction: the turn continues without compacting. Pi checks the threshold again later.
- Overflow recovery: the turn ends with the provider's overflow error. Pi does not retry.
- Manual `/compact`: Pi reports that compaction was cancelled, and the extension's notification explains why.

In print and JSON modes there is no dialog-capable UI, so notifications fall back to stderr, which keeps `/deepseek-compaction` and failure diagnostics visible under `pi --print` without corrupting a machine-readable stdout stream.

## Provider and cache notes

The extension contains nothing provider-specific. Only the cache expectations differ:
- Automatic prefix caching (DeepSeek, OpenAI, most OpenAI-compatible servers, implicit caches elsewhere): an identical prefix is sufficient. DeepSeek caches automatically with no write API, expires entries within hours to days, and reports hits as `prompt_cache_hit_tokens`, which pi-ai maps to `usage.cacheRead`.
- Explicit cache-marker providers (Anthropic-style `cache_control`): the default `cacheRetention: "inherit"` reproduces what normal turns send, so markers and their positions match and the replayed prefix is readable.
- Mid-conversation system messages: providers that support them keep prompt and tool patches in place, so the prefix stays byte-stable across a change. Providers that do not (DeepSeek) get the patches collapsed into the leading system message, which changes the head of every request after a change. Exactness holds either way because the summarize call and the real turn share the transcript and adapter. What changes is whether a prompt or tool change also costs a normal turn its cache entry.
- Cache granularity is provider-defined and hits are best-effort. A provider can take seconds to build the cache entry for the newest request, so a large tool result added moments earlier may not be cached yet even though the prefix matches exactly. The status ratio is the honest measure.
- Caches are per-model, so prefix reuse applies only when the configured summarization model equals the session model.
- Coverage is DeepSeek. Other providers are expected to work unchanged, and the status ratio is the way to find out.

## Composability

| Extension | Interaction |
| --- | --- |
| `autonomous-turn-compaction` | Aborts at a turn boundary and turns it into overflow compaction. |
| `cyber-policy-retry` | Injects a one-shot user message at the end of a retry request, so it never falls inside the replayed prefix. Fidelity drops visibly if that ever changes. |
| `openai-responses-input-status-compat` | Patches OpenAI Responses payloads. This extension only observes the `context_with_system` hook and never returns a payload or a message list. |
| `persist-bash-full-output` | Rewrites tool results before they are persisted, so both the real request and the replay see the same text. |
| `silent-overflow-compaction` | Rewrites a degenerate assistant message into an overflow error, which triggers Pi's overflow compaction and therefore this hook. Pi's message transform skips errored assistant messages, so the replayed prefix still matches the real request. |
| `upstream-fallback-retry` | Error classification on `message_end` only. |
| `pi-openai-server-compaction` | Both claim `session_before_compact`. Not co-enabled. |

The extension registers no provider, patches no payload, and mutates no session entry, which is what keeps these compositions safe.

## Repository layout

```
~/pi-deepseek-compaction/
  PLAN.md               # this document
  README.md             # user-facing: install, config, behavior, testing
  package.json          # "pi": { "extensions": ["./src/index.ts"] }
  tsconfig.json         # NodeNext, strict, noEmit (src and tests)
  src/
    index.ts            # hook wiring, session state, compaction handler, status command, failure reporting
    config.ts           # tolerant file and environment config resolution, rejected-value report
    settings.ts         # Pi's own settings via pi.getSettings(), used by the status command
    prefix.ts           # session-projection slicing, pricing, fingerprints
    instruction.ts      # instruction text and version, Pi's framing text, custom-instruction merge
    resolve.ts          # model / thinking level / output cap resolution, ConfigProblem
    summarize.ts        # injected-completion summarize call, response validation, shrink check
    fileops.ts          # read/write/edit extraction, cumulative merge, <read-files> formatting
    capture.ts          # per-session request fingerprints
    status.ts           # rolling statistics and status report text
    types.ts            # config, details, and record types
  scripts/smoke.mjs           # offline module smoke test
  scripts/pi-prefix-check.mjs # npm run test:e2e: offline prefix check through real Pi
  tests/unit/                 # node:test over the pure modules and the injected provider call
  tests/wire/                 # local mock endpoint driving pi-ai's real openai-completions provider
  tests/live/                 # opt-in real-provider cache measurement
```

## Testing

- Unit tests (`npm run test:unit`): projection slicing (plain entries, previous compaction replay, system prompt state kept out of the summarized span, context-edit omission applied through Pi's own `buildSessionProjection`, missing-cut and empty-span errors), instruction building with and without `customInstructions`, response validation (empty, tool call, length stop, non-shrinking), file-operation accumulation across our own `details` and Pi's flat shape, config precedence and rejected values, model and thinking resolution, pricing and fingerprint behaviour, rolling statistics, and the summarize call envelope through an injected completion function.
- Wire test (`npm run test:wire`): a local `node:http` mock answers `POST /chat/completions`, driving pi-ai's real `openai-completions` provider. Three cases run: auto-detected compatibility, DeepSeek compatibility with replayed reasoning content, and a transcript that exercises the mid-session mechanisms — a prompt section patch, a tool loadout change, and context edits that omit a failed attempt. Each case captures a real request and the summarize request and asserts that the summarize body's leading messages are deep-equal to the real request's, that the tool loadout matches, that omitted content is absent from both, and that the instruction is the only message after the prefix.
- End-to-end check (`npm run test:e2e`): spawns Pi itself against a local mock provider in a scratch project that forces threshold compaction, while a probe extension adds a tool to the loadout on the second turn. Every captured summarize request must equal the preceding real request's prefix plus the instruction, with identical tools across both loadouts. Requires `pi` on PATH.
- Smoke script (`npm run smoke`): runs the pure modules on a fixture and checks the documented defaults and formats.
- Live measurement (`npm run test:live`, opt-in): replays a fixture prefix a previous request just sent and asserts `cacheWrite == 0` and `cacheRead > 0`, retrying once because cache construction takes seconds, then reports the measured ratio. On `deepseek-flash` it measured `cacheRead 256 / prefix ~289 = 0.89`, costing under one tenth of a cent.

Cost rule: the default test run is entirely offline. Only the live measurement contacts a real provider, requires `PI_DEEPSEEK_COMPACTION_LIVE=1` plus a real key, is never part of `npm test`, is never wired into CI, and keeps its fixture around a thousand tokens.

## Limitations and deferred work

- The extension requires Pi 1.0.x host APIs and has no fallback for older versions. Loading it on one fails visibly rather than silently replaying a different prefix.
- Providers without mid-conversation system messages (DeepSeek) collapse prompt and tool patches into the leading system message, so a prompt or tool change still invalidates the next normal turn's cache. The replay remains exact. The loss is inherent to the provider.
- A `before_agent_start` handler can force a per-turn system prompt that is deliberately not recorded in the transcript. A compaction at the end of such a turn replays the recorded prompt and misses that one turn's cache.
- Split turns produce one summary spanning the whole prefix rather than Pi's two-call history-plus-prefix merge. The instruction's `Current Work` and `Next Step` sections carry that role.
- Cancelling on failure means a failed overflow compaction leaves the turn failed, with no automatic fallback. This is intentional and is covered by tests.
- Deferred: a retry without `toolChoice` when a server rejects it alongside a non-empty tool list, a manual recall benchmark against Pi's default compactor, and tool-result truncation at `tool_result` time (which is cache-neutral because it happens before a result enters any request).
