# Plan: prefix-preserving compaction for Pi

This document is the implementation plan for `pi-deepseek-compaction`, a Pi extension that replaces Pi's compaction summary generation with a DSH-style summarization call that reuses a real request prefix for provider-side prompt cache hits.

The directory and package keep the `deepseek-compaction` name for historical reasons, but the extension is provider-generic: it uses only basic LLM features (a chat/completions-style request with a system prompt, tool schemas, and messages), so it works for any provider and model Pi can talk to. No dedicated compaction endpoint, no provider-specific patch protocol.

The plan follows Pi's design and data structures: Pi still owns the compaction trigger policy, the `CompactionEntry`, `firstKeptEntryId`, the `session_before_compact` hook, `details`, `usage`, `/compact [instructions]`, and session/tree semantics. The extension only replaces how the summary text is produced, and it contributes to Pi's existing compaction flow rather than adding a parallel one.

## Decisions already made

- Default summary output cap is Pi's formula: `floor(0.8 * reserveTokens)`, clamped by `model.maxTokens`, where `reserveTokens` comes from Pi's compaction settings (default 16384).
- The summarization model and thinking level are configurable, in the style of `pi-openai-server-compaction`'s `compactionEndpoint` block and its environment overrides.
- Prefix cache reuse is expected only when the configured compaction model is the same model as the current session model. When the configured model differs, the extension still works but does not claim cache reuse, and it says so once per session.
- Pi's `<read-files>` / `<modified-files>` blocks are kept, with cumulative tracking across compactions.
- On any failure, the extension cancels compaction (`{ cancel: true }`) and never falls back to Pi's built-in compactor. Pi's original behavior is never invoked, which also keeps the extension's logic simple: one success path and one failure path.
- Configuration follows `pi-openai-server-compaction`: loading never throws, a malformed file behaves like a missing file, invalid values fall back to defaults, and unknown fields are ignored. Problems that only surface at use time, such as an unresolvable summarization model or an unsupported thinking level, are reported once with a warning notification, after which the compaction cancels rather than falling back to Pi's compactor.
- `notify` defaults to `"off"`, so a successful compaction looks exactly like Pi's own compaction: no extra UI. Cache statistics are inspected on demand through the `/deepseek-compaction` status command. Failures still notify once with a warning regardless of `notify`, because a cancelled compaction with no explanation would look like a hang.
- `cacheRetention` defaults to `"none"`.
- Failures are reported through the UI notification and the status command only. The extension creates no diagnostic session entries, and a successful compaction is recorded solely in the ordinary `CompactionEntry.details`.
- The extension applies to every provider and model, with no allowlist. Enablement is Pi's concern: the `packages` entry in settings, `-e`, or `--no-extensions` decides whether the extension is loaded at all.
- The status command reports the last compaction's `cacheRead / prefixTokens` ratio and the same ratio rolled up over the compactions this extension performed in the session, both computed from ordinary `CompactionEntry.details`.

## Objective and success criteria

The summarization request sent to the provider must be a byte prefix of a request the provider has already served, so the provider's prefix cache serves most of the input, while the request itself asks for no cache write.

| Criterion | Evidence |
| --- | --- |
| The summarize request's system message, tools, and leading messages are byte-identical to a prior real request | Offline wire test against a local mock endpoint: deep-equality of the shared prefix of two captured request bodies |
| The provider serves the shared prefix from cache | Live test on a provider with automatic prefix caching: `usage.cacheRead` is non-zero and `cacheWrite == 0`, with the measured ratio reported rather than asserted at a fixed level |
| Successful compactions land in Pi's normal data structures | Pi session JSONL contains an ordinary `compaction` entry with `summary`, `firstKeptEntryId`, `tokensBefore`, `usage`, and `details` |
| Failures never run Pi's default compactor and never write a partial compaction | Failure paths return `{ cancel: true }`; the session contains no compaction entry, and the UI notification plus the status command explain why |
| Normal turns are untouched | The extension never mutates provider payloads and never mutates session entries; its only effect is the compaction hook's return value |

## Non-goals

- Changing Pi's compaction trigger thresholds. The extension composes with `autonomous-turn-compaction` and `silent-overflow-compaction` instead of duplicating them.
- DSH's durable log bracket, surface replacement, invariant plugin, and `compaction/*` events. Pi has no model-visible surface abstraction and the plan deliberately keeps `CompactionEntry`.
- Tool-result pruning, remote or opaque compaction artifacts, and branch summarization.
- Provider-specific cache protocols. Explicit-cache providers are supported through the `cacheRetention` knob, not through custom code.

## Where it plugs in

| Hook | Use | Side effects |
| --- | --- | --- |
| `session_before_compact` | The extension's whole job: read `event.preparation` (`firstKeptEntryId`, `tokensBefore`, `isSplitTurn`, `previousSummary`), `event.branchEntries`, `event.reason`, `event.customInstructions`, `event.signal`; return `{ compaction }` or `{ cancel: true }` | Returns a value; writes nothing |
| `context` | Read-only capture of the last real request's message fingerprints, used for prefix fidelity diagnostics | Never returns a value |
| `session_start`, `session_shutdown`, `session_before_switch`, `session_before_fork`, `session_before_tree`, `session_compact` | Drop or rebuild in-memory capture state | None |
| `registerCommand` | `/deepseek-compaction` status command: resolved models, Pi's thresholds and the derived token cap, the last compaction's `cacheRead / prefixTokens` ratio, the session rolling ratio, and the last failure reason | None |

`session_before_compact` is reached from all three Pi compaction paths, so one handler covers DSH's pressure, overflow, and on-demand behavior without touching Pi core:
- threshold compaction from `_checkCompaction` (checked before a new prompt, after a tool batch, and after a low-level run),
- overflow recovery (`reason: "overflow"`, `willRetry: true` when the aborted turn is retried),
- manual `/compact [instructions]` (`reason: "manual"`).

## The summarization request

The request is built as:

```
[ system message               ]  ctx.getSystemPrompt()
[ tools                        ]  pi.getAllTools() filtered by pi.getActiveTools()
[ context entries before cut   ]  Pi's compaction-aware context, converted with convertToLlm
[ user: compaction instruction ]  the only new tokens
```

The system message, the tools, and every prefix message must match what a real turn already sent. The instruction is appended as the final user message, which is exactly how DSH makes its summarize call a prefix of the last routed request.

Build steps:
- `const contextEntries = buildContextEntries(event.branchEntries)` gives Pi's own compaction-aware entry list, which already begins with the previous compaction's summary entry when one exists.
- Find the cut: `contextEntries.findIndex(entry => entry.id === preparation.firstKeptEntryId)`. Using Pi's cut inherits Pi's semantics for free: turn boundaries, never cutting at a tool result, and split turns.
- Take the entries before the cut, project them with `sessionEntryToContextMessages`, and convert with `convertToLlm` - the same functions Pi uses to build a real request. Split-turn prefix messages are included in place, so one call replaces Pi's two-call history-plus-prefix merge.
- Append the instruction as a final user message.

Sketch:

```ts
const contextEntries = buildContextEntries(event.branchEntries);
const cut = cutIndexFor(contextEntries, event.preparation.firstKeptEntryId);
const prefixEntries = cut > 0 ? contextEntries.slice(0, cut) : [];
const prefixMessages = convertToLlm(prefixEntries.flatMap(sessionEntryToContextMessages));

const response = await completeSimple(model, {
  systemPrompt: ctx.getSystemPrompt(),
  messages: [...prefixMessages, instructionMessage(event.customInstructions)],
  tools: activeTools,
}, {
  apiKey,
  headers,
  signal: event.signal,
  maxTokens,
  reasoning: resolvedThinkingLevel,
  cacheRetention,
  toolChoice: "none",
});
```

Why the prefix is genuine:
- Pi's `buildSessionContext` is `buildContextEntries(...).flatMap(sessionEntryToContextMessages)`, so the rebuild uses the same code path as the loop.
- `convertToLlm` and pi-ai's `transformMessages` are deterministic per message. The only array-dependent behavior in `transformMessages` is inserting synthetic tool results for unresolved calls, and Pi's cut never leaves the summarized region ending on an unresolved assistant tool call, so no synthetic content can appear inside the prefix.
- `completeSimple` goes through the same adapter as a real turn (`openai-completions` for DeepSeek and most OpenAI-compatible providers, `anthropic-messages`, `google-generative-ai`, and so on), so system-prompt placement, tool serialization, thinking-content handling, and compat flags are applied identically.
- `toolChoice: "none"` keeps the tool schemas in the request (they are part of the cached prefix) while preventing the summarizer from calling a tool.
- The previous compaction's summary is already inside the prefix as a `compactionSummary` message, so `preparation.previousSummary` needs no separate prompt block; the instruction tells the model to merge it.

Prefix diagnostics: a read-only `context` handler records the fingerprint of every agent message a real request is about to send. The `context` hook is the right place because it hands over the same agent-message representation that prefix rebuilding produces, so both sides are comparable; the provider payload seen at `before_provider_request` has already been converted to wire form and cannot be compared message by message. At compaction time the same fingerprints are computed over the rebuilt prefix, which yields `sharedPrefixMessages` and `sharedPrefixTokens`. The values are reported in `details`, in the status command, and in diagnostic notifications. A divergence never blocks the call; it means a partial cache miss and a diagnostic worth seeing.

## The instruction

`event.customInstructions` from `/compact <text>` is appended as an `Additional focus:` paragraph, preserving Pi's manual-compaction feature.

The instruction text carries a version constant that is recorded in `details`, so a later reviewer can tell which prompt produced a stored summary.

Pi's `compactionSummary` framing (the `The conversation history before this point was compacted into the following summary:` wrapper around `<summary>`) stays as the replay framing. The wrapper carries the same information as DSH's checkpoint preamble; replacing it would require a `context` hook that rewrites every request, which the plan avoids.

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
        prefixMessages,
        prefixTokens,
        sharedPrefixMessages,
        sharedPrefixTokens,
        cacheRead,
        cacheWrite,
        summaryTokens,
        reason: event.reason,                  // "manual" | "threshold" | "overflow"
        customInstructionsUsed: boolean,
      },
    },
  },
}
```

Notes:
- Pi's cache-miss accounting already resets at compaction entries, so the post-compaction turn is not counted as a self-inflicted miss.
- Pi skips `details` from extension-provided compactions when it accumulates file operations (`!prevCompaction.fromHook`), so cumulative file tracking must read our own `details` first and then Pi's legacy `{ readFiles, modifiedFiles }` shape. Otherwise file history is lost on the second compaction.
- Validation before returning: non-empty text, no tool calls, `stopReason !== "length"`, and the summary must be strictly smaller than the summarized span (sum of `estimateTokens` over the prefix messages). Any failure cancels the compaction instead of landing a non-shrinking or truncated checkpoint.

## Status command and the rolling cache ratio

The status command answers one question: is the prefix actually being reused? It reports the resolved session and summarization models, Pi's `reserveTokens` and `keepRecentTokens`, the derived `maxTokens`, the last compaction's ratio, and the rolling ratio for the session. Because `notify` defaults to `"off"`, this command is the only place the cache statistics appear.

```text
deepseek-compaction: loaded (Pi-owned enablement; notify off)
Config: ~/.pi/agent/deepseek-compaction.json (missing) + <project>/.pi/deepseek-compaction.json (found)
Effective: model=(session) thinkingLevel=off maxTokens=1024 cacheRetention=none fileLists=true dryRun=false
Session model: deepseek/deepseek-flash
Summarize model: deepseek/deepseek-flash (same model: prefix reuse expected)
Pi settings: reserve 1000000, keepRecent 1
Compactions by this extension: 2 (other compactions skipped: 0)
Last:    cacheRead 1152 / prefixTokens 1778 = 0.65   prefix fidelity 3/3 messages   (threshold, deepseek/deepseek-flash)
Rolling: cacheRead 2304 / prefixTokens 15976 = 0.14
Last failure: none
Configuration problems:
- ~/.pi/agent/deepseek-compaction.json: invalid value "verbose"; using "off"
```

The rolling number is defined as follows.
- Source of truth is `ctx.sessionManager.getEntries()` filtered to `entry.type === "compaction"` with `details.dshCompaction`. Reading entries rather than in-memory counters means the numbers survive a resume, a fork, and a tree navigation, because Pi rehydrates entries from the session file.
- `prefixTokens` for one compaction is a plain fold of Pi's exported `estimateTokens` over the messages this extension sent for the summarize call, with the system prompt counted as one message. Pi exposes no helper that prices an arbitrary message array: `estimateMessagesTokens` exists only inside Pi's agent session, and `ctx.getContextUsage()` describes the live session context rather than a message list. No tokenizer and no per-provider pricing are involved. Tool schemas are excluded because Pi's estimator prices messages only, so the ratio is systematically understated; the provider-reported prompt size (`input + cacheRead + cacheWrite` from the summarize call's `usage`) is recorded in `details` as the exact cross-check. `cacheRead` is the provider's reported cache-hit token count, which includes tool schemas, so a ratio slightly above 1.0 is possible and is not clamped.
- `ratio` for one compaction is `cacheRead / prefixTokens`. The rolling figure is `sum(cacheRead) / sum(prefixTokens)` over every compaction this extension recorded in the session, shown with the count so a single entry cannot masquerade as a trend.
- `prefix fidelity` is the last compaction's `sharedPrefixMessages / prefixMessages`, computed from the fingerprints captured on the `context` hook. It separates the two failure modes: a low ratio with full fidelity means the provider did not cache, while a low fidelity means the prefix no longer matched the real request.
- Compactions made by Pi's default compactor, by a different extension, or before this extension was mounted have no `details.dshCompaction`. They are counted in the `other compactions skipped` figure and excluded from the ratio, so the rolling number never mixes unlike measurements.
- The last failure reason is process-local in-memory state, since failures leave no session entry. It is cleared at `session_start` and on the next successful compaction.

## Configuration

Configuration is read from `~/.pi/agent/deepseek-compaction.json` and `<cwd>/.pi/deepseek-compaction.json` (project wins), with `PI_DEEPSEEK_COMPACTION_*` environment overrides, mirroring the shape of `pi-openai-server-compaction`.

```json
{
  "compaction": {
    "model": "",
    "thinkingLevel": "",
    "maxTokens": 0,
    "cacheRetention": "none"
  },
  "fileLists": true,
  "notify": "off",
  "dryRun": false
}
```

There is no `enabled` flag. Loading the extension is the switch: keep or remove the package entry in Pi settings, run with `-e ./src/index.ts`, or run with `--no-extensions` to bypass every extension.

Configuration handling follows `pi-openai-server-compaction`. Resolution never throws and never blocks loading: both files are read tolerantly, a parse error or a non-object file behaves like a missing file, every field is coerced with a fallback default, and unknown fields are ignored. There is no startup validation report; `/deepseek-compaction` prints the effective resolved configuration and the files it read, so a silently ignored typo is still discoverable. The two problems that cannot be decided from a file alone, an unregistered `compaction.model` and an unsupported `compaction.thinkingLevel`, are detected at first use, reported once per session with a warning notification, and then the compaction cancels. That terminal action is the one deliberate divergence from `pi-openai-server-compaction`, which returns `undefined` in the same situation and lets Pi's own compactor run.

| Field | Default | Meaning |
| --- | --- | --- |
| `compaction.model` | `""` | Model id used for the summarize call. Empty means the current session model, which is also the only value that yields prefix cache reuse. |
| `compaction.thinkingLevel` | `""` | Thinking level for the summarize call: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Empty means the session's current level. Validated against the resolved model's `thinkingLevelMap`. |
| `compaction.maxTokens` | `0` | Output cap. `0` means `floor(0.8 * reserveTokens)` clamped by `model.maxTokens`; `reserveTokens` is read from Pi's compaction settings with Pi's default of 16384. |
| `compaction.cacheRetention` | `"none"` | Passed to pi-ai as `cacheRetention`. `"none"` requests no cache write; automatic prefix caches such as DeepSeek's are read regardless. Set `"short"` or `"long"` for providers that need explicit cache markers. |
| `fileLists` | `true` | Append Pi's `<read-files>` / `<modified-files>` blocks and record them in `details`. |
| `notify` | `"off"` | `"off"`, `"summary"` (one line after each successful compaction), or `"diagnostic"` (also reports prefix statistics). Failure notifications ignore this setting and always appear once as a warning. |
| `dryRun` | `false` | Build and log the request, log the diagnostics, then cancel. Used by tests and for manual inspection. |

Environment overrides: `PI_DEEPSEEK_COMPACTION_MODEL`, `PI_DEEPSEEK_COMPACTION_THINKING_LEVEL`, `PI_DEEPSEEK_COMPACTION_MAX_TOKENS`, `PI_DEEPSEEK_COMPACTION_CACHE_RETENTION`, `PI_DEEPSEEK_COMPACTION_NOTIFY`, `PI_DEEPSEEK_COMPACTION_DRYRUN`.

`reserveTokens` and `keepRecentTokens` stay Pi's settings; the extension reads them only to derive the default `maxTokens`, so Pi remains the single owner of compaction thresholds.

## Model and thinking level resolution

Resolution happens at compaction time, after configuration is loaded:
- The session model is `ctx.model`. If it is missing, the compaction cancels with a clear reason.
- The summarization model is `compaction.model` when set, otherwise the session model.
- A configured model id is resolved through `ctx.modelRegistry.find(sessionModel.provider, configuredId)`. If it is not registered, the compaction cancels with a configuration error rather than silently substituting a model.
- Credentials and headers come from `ctx.modelRegistry.getApiKeyAndHeaders(resolvedModel)`, the same path a normal turn uses, so proxies, custom base URLs, and provider-specific headers keep working.
- The thinking level is `compaction.thinkingLevel` when set, otherwise `pi.getThinkingLevel()`. When set, it is mapped through the model's `thinkingLevelMap` when present and validated against the level list; an unsupported level cancels with a configuration error.
- When the resolved summarization model differs from the session model, the extension notifies once per session that prefix cache reuse is not expected. This is the documented trade-off: a cheaper summarizer costs a full-price input.

## Failure policy: cancel

Every failure path returns `{ cancel: true }`. Pi's own compactor is never invoked, so Pi's original behavior is never a silent second act, and the extension's logic stays simple.

Failure paths:
- no current model, or a configured summarization model that cannot be resolved,
- invalid thinking level for the resolved model,
- missing credentials,
- prefix construction failure (no `firstKeptEntryId` in the context, empty prefix, or an exception while projecting entries),
- request failure or rejection from `completeSimple`,
- empty summary text, tool call in the summary, or `stopReason === "length"`,
- summary not strictly smaller than the summarized span,
- an aborted `event.signal`, which also returns `{ cancel: true }` so Pi reports a cancellation rather than a failure,
- `dryRun` after logging.

Because `{ cancel: true }` carries no message, the reason is surfaced through `ctx.ui.notify` with a warning, and kept in memory for the status command's `Last failure:` line. Failure notifications are not gated by `notify`, which only governs success chatter. The extension writes no session entry for a failure: the session keeps only its ordinary entries, and Pi's own runtime events (`compaction_end`, `session_compact_failed`) still fire for anything listening. A successful compaction needs no extra record either, because the ordinary `CompactionEntry.details` already holds the full account.

What cancelling means per trigger:
- Threshold compaction: the turn continues without compacting. Pi will check the threshold again at the next opportunity.
- Overflow recovery: the turn ends with the provider's overflow error; Pi does not retry.
- Manual `/compact`: Pi reports that compaction was cancelled, and the extension's notification explains why.

This is a deliberate behavior difference from `pi-openai-server-compaction`, which falls back to a portable summary when its artifact path fails.

## Provider and cache notes

The extension itself contains nothing provider-specific, and only the cache expectations differ:
- Automatic prefix caching (DeepSeek, OpenAI, most OpenAI-compatible servers, implicit caches elsewhere): passing the identical prefix is sufficient. DeepSeek caches automatically with no write API, expires entries within hours to days, and reports hits as `prompt_cache_hit_tokens`, which pi-ai maps to `usage.cacheRead`.
- Explicit cache-marker providers (Anthropic-style `cache_control`): with the default `cacheRetention: "none"` no marker is sent, so those providers neither write nor read a cache for this call. Setting `cacheRetention` to `"short"` or `"long"` lets such providers read an existing breakpoint and write the new tail; the cost trade-off is the operator's choice.
- Cache granularity is provider-defined, and cache hits are best-effort everywhere. The offline test asserts an exact prefix, while the live measurement asserts only that a read happened (`cacheRead > 0`, `cacheWrite == 0`) and reports the ratio: a provider can take seconds to build the cache entry for the newest request, so a fresh large tool result may not be cached when the summarize call arrives even though the prefix matches exactly. The status command's ratio is the honest measure of what happened.
- Because caches are per-model, prefix reuse only applies when the configured summarization model equals the session model. This is documented in the README and in the one-time notification.
- Coverage is DeepSeek only. Other providers are expected to work with no code changes because the extension uses nothing provider-specific; their cache behavior is simply not measured here, and the status command's ratio is the way to find out.

## Composability

| Extension | Interaction | Handling |
| --- | --- | --- |
| `silent-overflow-compaction` | rewrites a degenerate assistant message into an overflow error, which triggers Pi's overflow compaction and therefore this hook. Pi's message transform skips errored assistant messages, so the rebuilt prefix still matches the last real request | none needed; covered by a unit fixture with an errored assistant entry |
| `autonomous-turn-compaction` | aborts at a turn boundary and turns it into overflow compaction | none needed |
| `cyber-policy-retry` | injects a one-shot user message at the end of a retry request, so it never falls inside the prefix | diagnostic reports a shorter `sharedPrefixMessages` if it ever does |
| `persist-bash-full-output` | rewrites tool results before they are persisted, so both the real request and the rebuilt prefix see the same text | none needed |
| `upstream-fallback-retry` | error classification on `message_end` only | none needed |
| `openai-responses-input-status-compat` | patches OpenAI Responses payloads; this extension only observes the `context` hook and never returns a payload or a message list | none needed |
| `pi-openai-server-compaction` | both claim `session_before_compact` | explicitly not co-enabled |

The extension registers no provider, patches no payload, and mutates no session entry, which is what keeps these compositions safe.

## Repository layout

```
~/pi-deepseek-compaction/
  PLAN.md               # this file
  README.md             # user-facing: install, config, behavior, testing
  package.json          # "pi": { "extensions": ["./src/index.ts"] }; peerDependencies on the pi packages
  tsconfig.json         # NodeNext, strict, noEmit (src and tests)
  src/
    index.ts            # hook wiring, session state, compaction handler, status command, failure reporting
    config.ts           # tolerant file and environment config resolution, rejected-value report
    settings.ts         # reads Pi's reserveTokens / keepRecentTokens
    prefix.ts           # cut selection, prefix projection, tool list, pricing, fingerprints
    instruction.ts      # instruction text and version, Pi's framing text, custom-instruction merge
    resolve.ts          # model / thinking level / output cap resolution, ConfigProblem
    summarize.ts        # completeSimple call, response validation, shrink check
    fileops.ts          # read/write/edit extraction, cumulative merge, <read-files> formatting
    capture.ts          # per-session request fingerprints
    status.ts           # rolling statistics and status report text
    types.ts            # config, details, and record types
  scripts/smoke.mjs     # offline module smoke test
  tests/unit/           # node:test over the pure modules and the injected provider call
  tests/wire/           # local mock endpoint driving pi-ai's real openai-completions adapter
  tests/live/           # opt-in real-provider cache measurement
```

## Testing and evidence

- Unit tests (`npm run test:unit`, `node --test` over `tests/unit/*.test.ts`; Node's type stripping needs no flag on Node 25): cut-to-prefix selection (no prior compaction, prior compaction, split turn, errored assistant entry, trailing tool result), instruction building with and without `customInstructions`, response validation (empty, tool call, length stop, non-shrinking), file-operation accumulation across our own `details` and Pi's flat shape, config precedence, fallbacks, and rejected values, model/thinking resolution including the unsupported-level error, pricing and fingerprint behaviour, the rolling-ratio computation over mixed entry lists, and the summarize call envelope through an injected completion function.
- Wire-shape test, the key offline test: a local `node:http` mock that answers `POST /chat/completions`, driving pi-ai's real `openai-completions` adapter through `completeSimple`. It captures a normal request and the summarize request and asserts that the second body's leading messages are deep-equal to the first body's, that `tools` and the system message match, that no cache-control or prompt-cache fields are present, that the output cap lands in the adapter's field, and that the instruction is the only message after the prefix. Two model configurations run: auto-detected compatibility and DeepSeek compatibility with replayed reasoning content.
- End-to-end run through Pi itself, offline in the sense that a mocked provider is not needed but a real provider is: `pi -ne -e ./src/index.ts --provider deepseek --model deepseek-flash --thinking off -a --print <prompt 1> <prompt 2>` in a scratch project whose `.pi/settings.json` sets `reserveTokens` above the model's context window so threshold compaction is forced. The session JSONL then shows a `fromHook: true` compaction entry with our summary, `<read-files>` block, `usage.cacheRead`, and `details.dshCompaction`.
- Live cache measurement, opt-in and cost-gated per the rule below: the summarize call replays a fixture prefix that a previous request just sent and asserts `cacheWrite == 0` and `cacheRead > 0`, retrying once because cache construction takes seconds, then reports the measured ratio instead of asserting a fixed one. Measured on `deepseek-flash`: `cacheRead 256 / prefix ~289 = 0.89` on a warmed fixture, total cost under one tenth of a cent.
- Smoke script (`npm run smoke`): runs the pure modules on a fixture and checks the documented defaults and formats; usable without credentials.
- Optional later: a recall benchmark comparing this summarizer against Pi's default on the same provider, in the spirit of the `pi-openai-server-compaction` benchmark reports. It is manual-only and subject to the same cost rule.

Cost rule. The default test run is entirely offline: unit tests, the local-mock wire test, and the smoke script make no network calls and spend nothing. Anything that talks to a real provider is opt-in twice over, requiring both an explicit script and an environment flag (`PI_DEEPSEEK_COMPACTION_LIVE=1`) alongside a real key, and it is never part of the default `npm test`, never wired into CI, and never given a fixture large enough for the bill to matter. The end-to-end Pi run described above is a manual verification step for the same reason.

## Implementation status

Implemented and passing:
- `npm test` = typecheck, 56 unit tests, 2 wire tests, and the smoke script.
- The extension loads in Pi 0.85.1 via `pi -ne -e ./src/index.ts`, and `/deepseek-compaction` prints the report in print mode through the stderr fallback.
- A forced threshold compaction in a real Pi session produced two `fromHook: true` compaction entries with DSH-style summaries, cumulative `<read-files>` blocks, `usage.cacheRead`, and full `details.dshCompaction`; the model answered the follow-up question correctly after compaction.
- A failing shrink check cancelled compaction, wrote no session entry, and left the conversation intact.
- The live DeepSeek measurement reported `cacheRead 256 / prefix ~289 = 0.89` with `cacheWrite 0`.

Observed provider behaviour worth remembering: in the end-to-end run, the summarize call shared 3/3 messages with the previous request yet read only 1,152 cached tokens of a 14,198-token prefix, because the large tool result had been added to the context seconds earlier and the provider had not finished building that cache entry. The system prompt and tools portion was cached. This is why the rollup reports a ratio instead of promising a hit rate, and why the live test retries before measuring.

## Milestones

- M0 (done): scaffold. Package metadata, tsconfig, config loader, typed hook wiring, status command, README.
- M1 (done): request builder and summarize call. Prefix projection, instruction, model/thinking/maxTokens resolution, response validation, shrink check, `details`, cancel-on-failure with notifications, and the status command with the rolling ratio.
- M2 (done): tests. Unit suite, wire-shape test, smoke script.
- M3 (done): file-list parity with cumulative tracking, prefix fingerprints that feed the fidelity figure, notify policy, and the stderr fallback for print and JSON modes.
- M4 (optional, not started): a manual recall benchmark, and tool-result truncation at `tool_result` time (which is cache-neutral because it happens before the result enters any request).

## Risks and open questions

Risks:
- Tool-list fidelity. `getAllTools()` filtered by `getActiveTools()` must match the agent's real tool array in content and order. The wire test confirms the same tool list serializes identically in both requests; it does not prove the list equals the agent's internal array, so a divergence would show up as low prefix fidelity rather than as a wrong request.
- Message-rewriting extensions that edit messages mid-array would shorten the shared prefix. The fingerprint diagnostic detects this, and a future `prefixSource: "captured"` mode could reuse the captured payload verbatim.
- Split-turn summaries differ from Pi's behavior: one call instead of two, described in the README.
- Cancelling on failure means an overflow compaction that fails leaves the turn failed, with no automatic fallback. This is intentional and is documented, but it makes the summarization path a single point of failure that the tests should cover well.

Decisions taken during implementation, replacing the open questions that preceded it:
- `toolChoice: "none"` is always sent; the instruction also forbids tool use, and a returned tool call fails validation and cancels. DeepSeek accepted it in the live run, and the wire test asserts it reaches the payload.
- A `firstKeptEntryId` that cannot be located in the compaction-aware context raises `PrefixBuildError`, which cancels with a clear reason. Pi's `prepareCompaction` already refuses to prepare in that situation, so this is a safety net rather than a path users should ever see.
- The status command prints the effective resolved configuration, both config file paths with found/missing markers, and every rejected value. Silent fallbacks were the reason the user asked for this, and the output stays under a screen.
- Every compaction records its prefix and shared-prefix figures, however short the prefix is, so the rolling ratio has no unexplained gaps.
- Print and JSON modes have no dialog-capable UI, so notifications fall back to stderr instead of being dropped. That is what makes `/deepseek-compaction` and failure diagnostics visible under `pi --print`.
- Cumulative file lists are read from both the top level of the entry details (Pi's shape, and the shape this extension writes) and a nested `dshCompaction` object, because preferring the nested copy silently dropped files after the second compaction during the end-to-end run. The regression is covered by a unit test.

Genuinely open, deliberately deferred:
- Whether the summarize call should retry once without `toolChoice` when a server rejects it with a non-empty tool list. Today that cancels, which is safe but loses the compaction.
- Whether a manual recall benchmark is worth its cost, and how it should be scored.
