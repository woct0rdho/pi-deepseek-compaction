// Capture of the last real request, used both to report how much of the rebuilt
// prefix a provider has actually seen and to replay the request shape the
// provider cached. Two hooks feed one record per session:
// - `context_with_system` hands over the full transcript - including the system
//   messages that declare the prompt and tool loadout - so message fingerprints
//   are comparable with prefix rebuilding.
// - `before_provider_request` hands over the payload Pi actually sent, which the
//   summarize call replays field for field (see replay.ts).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fingerprintMessages } from "./prefix.ts";
import type { RequestPayloadShell } from "./replay.ts";

export interface CapturedRequest {
  at: number;
  modelKey: string;
  messageHashes: string[];
  // Shape of the last payload Pi sent for this model, when one was observed.
  shell?: RequestPayloadShell;
}

export class RequestCaptureStore {
  private readonly bySession = new Map<string, CapturedRequest>();

  capture(sessionId: string, modelKey: string, messages: readonly AgentMessage[]): void {
    // A payload shape only describes the model it was sent for. Keep it across
    // turns of the same model, drop it when the session switches models.
    const previous = this.bySession.get(sessionId);
    const shell = previous?.modelKey === modelKey ? previous.shell : undefined;
    this.bySession.set(sessionId, {
      at: Date.now(),
      modelKey,
      messageHashes: fingerprintMessages(messages),
      ...(shell === undefined ? {} : { shell }),
    });
  }

  capturePayload(sessionId: string, modelKey: string, shell: RequestPayloadShell | undefined): void {
    if (shell === undefined) return;
    const previous = this.bySession.get(sessionId);
    if (previous === undefined) {
      // A request can be observed before the context hook on a resumed session.
      // The shape is still the last thing the provider saw.
      this.bySession.set(sessionId, { at: Date.now(), modelKey, messageHashes: [], shell });
      return;
    }
    if (previous.modelKey !== modelKey) return;
    previous.shell = shell;
  }

  get(sessionId: string): CapturedRequest | undefined {
    return this.bySession.get(sessionId);
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  clearAll(): void {
    this.bySession.clear();
  }
}
