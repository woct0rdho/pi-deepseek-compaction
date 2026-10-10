// Replay of the request shape the provider already cached.
//
// A provider's prompt cache is keyed on the prompt bytes *and* on the request
// shape: thinking mode, tool choice, tool schemas, and provider-specific extras
// all participate. Measured on DeepSeek, adding `tool_choice: "none"` to an
// otherwise identical 340k-token request turned a hit into a total miss, and a
// thinking-mode change did the same. Rebuilding the shape from session settings
// therefore drifts as soon as any option differs from what a normal turn sends.
//
// Instead of enumerating option fields, the extension keeps the payload Pi
// actually produced for the last real request (`before_provider_request`) and
// replays it for the summarize call, replacing only the messages and the output
// cap. Whatever Pi sent stays exact, including fields this file has never heard
// of, so the summarize request cannot drift when Pi or a provider changes.

export const MESSAGES_FIELD = "messages";

// Output caps the adapters may use. They are stripped from the replay because the
// summarize call sizes its own output, and a cap does not key the prompt cache:
// changing it between two identical prompts still hits (measured on DeepSeek).
export const OUTPUT_CAP_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

// Tool choices that force a tool call. Replaying them would make the summarize
// call emit a tool call instead of a checkpoint, so they are dropped and
// reported. Every other tool_choice value ("auto", "none") is replayed.
const FORCED_TOOL_CHOICE = "required";

export interface RequestPayloadShell {
  // Every field of the real payload except the messages and the output caps,
  // deep-cloned so later mutation of the sent object cannot alter the replay.
  fields: Record<string, unknown>;
  // Message count of the real request, for diagnostics.
  messageCount: number;
}

export interface ReplayFields {
  fields: Record<string, unknown>;
  // Fields intentionally not replayed, in payload order.
  adjusted: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutputCapField(key: string): boolean {
  return (OUTPUT_CAP_FIELDS as readonly string[]).includes(key);
}

function isForcedToolChoice(value: unknown): boolean {
  if (value === FORCED_TOOL_CHOICE) return true;
  // Object forms select one function ("function" for chat completions, a bare
  // name for other APIs). Both force a call.
  return isRecord(value);
}

// Split a payload Pi sent into the part worth replaying and its message list.
// Returns undefined for payloads that are not JSON objects.
export function payloadShell(payload: unknown): RequestPayloadShell | undefined {
  if (!isRecord(payload)) return undefined;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (key === MESSAGES_FIELD || isOutputCapField(key)) continue;
    fields[key] = payload[key];
  }
  const messages = payload[MESSAGES_FIELD];
  const shell: RequestPayloadShell = {
    fields: structuredClone(fields),
    messageCount: Array.isArray(messages) ? messages.length : 0,
  };
  return shell;
}

// Fields of a captured request that the summarize call can safely replay.
export function replayableFields(shell: RequestPayloadShell): ReplayFields {
  const fields: Record<string, unknown> = {};
  const adjusted: string[] = [];
  for (const key of Object.keys(shell.fields)) {
    const value = shell.fields[key];
    if (key === "tool_choice" && isForcedToolChoice(value)) {
      adjusted.push(key);
      continue;
    }
    fields[key] = value;
  }
  return { fields, adjusted };
}

// The replay to use for a summarize model, or undefined when the capture came
// from a different model (a different model means a different cache domain, so
// there is nothing to align with).
export function replayForCapture(
  captured: { modelKey: string; shell?: RequestPayloadShell } | undefined,
  modelKey: string,
): ReplayFields | undefined {
  if (captured?.shell === undefined || captured.modelKey !== modelKey) return undefined;
  return replayableFields(captured.shell);
}

// Pi's adapter payload with the captured shape reapplied: our messages, the
// captured everything else, and our output cap. Payloads that are not objects
// are returned untouched, so an unusual provider payload never breaks a call.
export function mergeReplayPayload(
  built: unknown,
  replay: ReplayFields | undefined,
  maxTokens: number | undefined,
): unknown {
  if (replay === undefined || !isRecord(built)) return built;
  const merged: Record<string, unknown> = { ...built, ...replay.fields };
  merged[MESSAGES_FIELD] = built[MESSAGES_FIELD];
  if (maxTokens !== undefined) {
    for (const key of OUTPUT_CAP_FIELDS) {
      if (key in merged) merged[key] = maxTokens;
    }
  }
  return merged;
}
