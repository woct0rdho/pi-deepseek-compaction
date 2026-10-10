# pi-deepseek-compaction

A Pi extension that replaces Pi's compaction summary generation with a prefix-preserving summarization call:
- The summarize request replays the exact leading transcript a real turn already sent - the system message that declares the prompt and tool loadout, later prompt/tool updates, context edits applied, and the conversation up to Pi's cut - then appends one instruction message. Providers with prefix caching (DeepSeek, OpenAI, most OpenAI-compatible servers) serve that prefix from cache, so compaction reads instead of re-billing the whole history.
- It also replays the rest of the request: the payload Pi sent for the last real turn is captured and reapplied, so the thinking mode, tool choice, and tool schemas are the ones the provider has cached. Only the messages and the output cap belong to the summarize call. A provider's cache identity covers the prompt *and* that shape - on DeepSeek a single re-added `tool_choice` was enough to turn a 340k-token hit into a total miss.
- The instruction asks for a DSH-style structured checkpoint: Primary Request and Intent, Key Technical Concepts, Files and Code, Errors and Fixes, Pending Jobs, Current Work, Next Step, Critical Context.
- Pi keeps everything else: its trigger policy, `CompactionEntry`, `firstKeptEntryId`, `details`, `usage`, `/compact [instructions]`, and session/tree semantics. Pi's `<read-files>` / `<modified-files>` blocks are preserved and accumulate across compactions.

## Install

Requires Pi 1.0 or newer. The extension uses the host's session projection, settings, `context_with_system` and `before_provider_request` hooks, and provider stack, and has no fallback path for older versions.

No provider or API is hardcoded. The extension works wherever Pi can make a normal request. It uses the current session model and Pi's model registry (`ctx.modelRegistry.streamSimple()`), so configured providers, OAuth, proxies, and custom base URLs keep working.

## Configuration

`~/.pi/agent/deepseek-compaction.json` (global) and `<cwd>/.pi/deepseek-compaction.json` (project, wins), with `PI_DEEPSEEK_COMPACTION_*` environment overrides:

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
| `compaction.model` | `""` | Model id used for the summarize call. Empty means the current session model, which is the only value that can reuse the prefix cache. |
| `compaction.thinkingLevel` | `""` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Empty uses the session level. |
| `compaction.maxTokens` | `0` | Output cap. `0` means Pi's formula, `floor(0.8 * reserveTokens)`, clamped by the model. |
| `compaction.cacheRetention` | `"inherit"` | `"inherit"` forwards nothing, so pi-ai applies exactly the retention a normal turn uses and cache markers, if any, land in the same place. On automatic-cache providers such as DeepSeek it makes no wire difference. Set `"none"`, `"short"`, or `"long"` to override. |
| `fileLists` | `true` | Append and accumulate Pi's `<read-files>` / `<modified-files>` blocks. |
| `notify` | `"off"` | `"off"`, `"summary"` (one line after each success), or `"diagnostic"` (also prefix fidelity and token counts). Failures always notify once as a warning. |
| `dryRun` | `false` | Build and report the request without calling the model. |

There is no `enabled` flag. Loading the extension is the switch. Configuration is read tolerantly. A malformed file behaves like a missing one, an invalid value falls back to its default, and `/deepseek-compaction` lists what was rejected.

`reserveTokens` and `keepRecentTokens` stay Pi's settings. The extension never re-derives them, and each compaction uses the values Pi hands to `session_before_compact` through `preparation.settings`.

## Behavior

- Triggers: Pi's threshold compaction, overflow recovery, and `/compact` all route through the extension's `session_before_compact` handler.
- The prefix: Pi's canonical session projection (`buildSessionProjection`) is truncated at `firstKeptEntryId`, so appended context edits, prompt section patches, and tool loadout changes are honored and the request is a byte prefix of what the provider already served. Split turns need no special case. The early part of the turn is simply replayed in place. No `systemPrompt` and no tool schemas are rebuilt - the provider adapter derives both from the replayed transcript, exactly as it does for a real turn - and the summarize call forwards the session id, so session-affinity caching routes it to the same cache as real turns.
- The request shape: a `before_provider_request` handler stores the payload Pi produced for the last real turn, and the summarize call reapplies it after the adapter builds its own payload. Messages and the output cap are the summarize call's; `tools`, `thinking`, `reasoning_effort`, `tool_choice`, and any provider-specific field are the ones the provider already cached. The capture is used only for the model it was captured from. If it is missing (first request of a session, or a different summarize model), the shape falls back to the resolved model and thinking level. A forced tool choice (`"required"` or a named function) is never replayed, because it would make the model call a tool instead of writing a checkpoint; neutralizing it costs that call's cache read and is recorded in the entry details.
- Validation: the summary must be non-empty text, must not call tools, must not be truncated, and must be strictly smaller than the history it replaces.
- Failures cancel: nothing is written and Pi's built-in summarizer is never invoked, so a failure leaves the conversation exactly as it was. The reason appears as a warning, or on stderr in print and JSON modes.
- Never silent: `/deepseek-compaction` reports the effective configuration, the resolved models, the replay source (the captured shape of the last real request), the last compaction's `cacheRead / prefixTokens` ratio, the rolling ratio over all compactions this extension recorded in the session, prefix fidelity (`sharedPrefixMessages / prefixMessages`), and the last failure.

Cache reads are best-effort and provider-defined. A provider may not have finished building the cache entry for content added seconds earlier, so the ratio is a measurement rather than a guarantee. Prefix fidelity and the replay source tell the failure modes apart: a low ratio with full fidelity and a replayed shape means the provider did not cache, while low fidelity means the prefix no longer matched, and a shape built from settings instead of a capture means the request may have looked different from the one the provider cached.

## Testing

```bash
npm test          # typecheck, unit tests, wire test, smoke. Offline, no provider calls
npm run test:e2e  # offline. Real Pi 1.0.x against a local mock provider (needs `pi` on PATH)
npm run test:live # opt-in. Requires PI_DEEPSEEK_COMPACTION_LIVE=1 and a DeepSeek key
```

The default run is entirely offline. The wire test drives pi-ai's real `openai-completions` provider against a local mock endpoint and asserts that the summarize request's leading messages, tool loadout, and full request shape are byte-identical to a real request, including a transcript with a prompt section patch, a mid-session tool loadout change, and context edits that omit a failed attempt, plus the two tool-choice cases (a neutral one replayed verbatim, a forced one dropped). The end-to-end check spawns Pi itself against the same kind of mock, forces a compaction, and diffs the captured request bodies, which also proves the host wiring (`context_with_system`, `before_provider_request`, `pi.getSettings()`, `buildSessionProjection`, `streamSimple`). The live test sends roughly a thousand tokens to a real endpoint, is never part of `npm test`, and is never wired into CI.

## Repository layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | Hook wiring, request capture, the compaction handler, the status command |
| `src/config.ts` | Tolerant config file and environment resolution |
| `src/settings.ts` | Pi's own settings via `pi.getSettings()`, used by the status command |
| `src/prefix.ts` | Session-projection slicing, pricing, fingerprints |
| `src/instruction.ts` | The compaction instruction and Pi's framing text |
| `src/resolve.ts` | Model, thinking level, and output-cap resolution |
| `src/summarize.ts` | The provider call and response validation |
| `src/fileops.ts` | Cumulative file lists and Pi's block formatting |
| `src/capture.ts` | Per-session request fingerprints |
| `src/status.ts` | Rolling statistics and status report text |
| `scripts/pi-prefix-check.mjs` | `npm run test:e2e`: offline end-to-end prefix check through real Pi |
