// Capture of the last real request's message fingerprints, used to report how
// much of the rebuilt prefix a provider has actually seen. Capture happens on
// the `context_with_system` hook, where Pi hands over the full transcript -
// including the system messages that declare the prompt and tool loadout - so
// both sides are comparable with prefix rebuilding.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fingerprintMessages } from "./prefix.ts";

export interface CapturedRequest {
  at: number;
  modelKey: string;
  messageHashes: string[];
}

export class RequestCaptureStore {
  private readonly bySession = new Map<string, CapturedRequest>();

  capture(sessionId: string, modelKey: string, messages: readonly AgentMessage[]): void {
    this.bySession.set(sessionId, {
      at: Date.now(),
      modelKey,
      messageHashes: fingerprintMessages(messages),
    });
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
