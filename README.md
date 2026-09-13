# pi-deepseek-compaction

A Pi extension that replaces Pi's compaction summary generation with a prefix-preserving summarization call:
- The summarize request replays the same system prompt, the same tool schemas, and the same leading messages a real turn already sent, then appends one instruction message. Providers with prefix caching (DeepSeek, OpenAI, most OpenAI-compatible servers) serve that prefix from cache, so compaction reads instead of re-billing the whole history.
- The instruction asks for a DSH-style structured checkpoint: Primary Request and Intent, Key Technical Concepts, Files and Code, Errors and Fixes, Pending Jobs, Current Work, Next Step, Critical Context.
- Pi keeps everything else: its trigger policy, `CompactionEntry`, `firstKeptEntryId`, `details`, `usage`, `/compact [instructions]`, and session/tree semantics. Pi's `<read-files>` / `<modified-files>` blocks are preserved and accumulate across compactions.

## Install

```bash
# project-local:
pi install -l ~/pi-deepseek-compaction
# or one-shot:
pi -e ~/pi-deepseek-compaction/src/index.ts --model deepseek/deepseek-flash
```

No provider or API is hardcoded. The extension works wherever Pi can make a normal request: it uses the current session model, `ctx.getSystemPrompt()`, and the active tool set.

## Configuration

`~/.pi/agent/deepseek-compaction.json` (global) and `<cwd>/.pi/deepseek-compaction.json` (project, wins), with `PI_DEEPSEEK_COMPACTION_*` environment overrides:

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

| Field | Default | Meaning |
| --- | --- | --- |
| `compaction.model` | `""` | Model id used for the summarize call. Empty means the current session model, which is the only value that can reuse the prefix cache. |
| `compaction.thinkingLevel` | `""` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Empty uses the session level. |
| `compaction.maxTokens` | `0` | Output cap. `0` means Pi's formula, `floor(0.8 * reserveTokens)`, clamped by the model. |
| `compaction.cacheRetention` | `"none"` | Forwarded to pi-ai. `"none"` requests no cache write; automatic prefix caches are read regardless. Use `"short"`/`"long"` for providers that need explicit cache markers. |
| `fileLists` | `true` | Append and accumulate Pi's `<read-files>` / `<modified-files>` blocks. |
| `notify` | `"off"` | `"off"`, `"summary"` (one line after each success), or `"diagnostic"` (also prefix fidelity and token counts). Failures always notify once as a warning. |
| `dryRun` | `false` | Build and report the request without calling the model. |

There is no `enabled` flag: loading the extension is the switch. Configuration is read tolerantly - a malformed file behaves like a missing one, an invalid value falls back to its default, and `/deepseek-compaction` lists what was rejected.

`reserveTokens` and `keepRecentTokens` stay Pi's settings (`~/.pi/agent/settings.json` and the project `.pi/settings.json`); the extension reads them only to derive the default output cap.

## Behavior

- Triggers: Pi's threshold compaction, overflow recovery, and `/compact` all route through the extension's `session_before_compact` handler.
- The prefix: Pi's compaction-aware context is truncated at `firstKeptEntryId` and converted with Pi's own functions, so the request is a byte prefix of what the provider already served. Split turns need no special case: the early part of the turn is simply replayed in place.
- Validation: the summary must be non-empty text, must not call tools, must not be truncated, and must be strictly smaller than the history it replaces.
- Failures cancel: nothing is written and Pi's built-in summarizer is never invoked, so a failure leaves the conversation exactly as it was. The reason appears as a warning, or on stderr in print and JSON modes.
- Never silent: `/deepseek-compaction` reports the effective configuration, the resolved models, the last compaction's `cacheRead / prefixTokens` ratio, the rolling ratio over all compactions this extension recorded in the session, prefix fidelity (`sharedPrefixMessages / prefixMessages`), and the last failure.

Cache reads are best-effort and provider-defined. A provider may not have finished building the cache entry for content added seconds earlier, so the ratio is a measurement rather than a guarantee; prefix fidelity tells the two failure modes apart (provider did not cache vs. prefix no longer matched).

## Testing

```bash
npm test          # typecheck, unit tests, wire test, smoke - offline, no provider calls
npm run test:live # opt-in; requires PI_DEEPSEEK_COMPACTION_LIVE=1 and a DeepSeek key
```

The default run is entirely offline. The wire test drives pi-ai's real `openai-completions` adapter against a local mock endpoint and asserts that the summarize request's leading messages, system prompt, and tools are byte-identical to a real request, with no cache-write fields. The live test sends roughly a thousand tokens to a real endpoint, is never part of `npm test`, and is never wired into CI.

## Repository layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | Hook wiring, request capture, the compaction handler, the status command |
| `src/config.ts` | Tolerant config file and environment resolution |
| `src/settings.ts` | Reads Pi's `reserveTokens` / `keepRecentTokens` |
| `src/prefix.ts` | Prefix rebuilding, tool collection, pricing, fingerprints |
| `src/instruction.ts` | The compaction instruction and Pi's framing text |
| `src/resolve.ts` | Model, thinking level, and output-cap resolution |
| `src/summarize.ts` | The provider call and response validation |
| `src/fileops.ts` | Cumulative file lists and Pi's block formatting |
| `src/capture.ts` | Per-session request fingerprints |
| `src/status.ts` | Rolling statistics and status report text |
| `PLAN.md` | Design plan, decisions, and what has been validated |
