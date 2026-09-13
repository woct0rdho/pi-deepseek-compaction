/**
 * Capture of the last real request's message fingerprints, used to report how
 * much of the rebuilt prefix a provider has actually seen. Capture happens on
 * the `context` hook, where Pi hands over the same agent-message representation
 * that prefix rebuilding produces, so both sides are comparable.
 * @module pi-deepseek-compaction/capture
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fingerprintMessages } from "./prefix.ts";

/** Fingerprints of one real request, keyed by session. */
export interface CapturedRequest {
  at: number;
  modelKey: string;
  messageHashes: string[];
}

/** Per-session capture store cleared on session lifecycle changes. */
export class RequestCaptureStore {
  private readonly bySession = new Map<string, CapturedRequest>();

  /**
   * Record the message fingerprints of one real request.
   * @param sessionId - session the request belongs to.
   * @param modelKey - `provider/model` the request was sent to.
   * @param messages - agent messages handed to the provider adapter.
   */
  capture(sessionId: string, modelKey: string, messages: readonly AgentMessage[]): void {
    this.bySession.set(sessionId, {
      at: Date.now(),
      modelKey,
      messageHashes: fingerprintMessages(messages),
    });
  }

  /**
   * Read the captured request for one session.
   * @param sessionId - session to look up.
   * @returns the capture, or undefined when the session has none.
   */
  get(sessionId: string): CapturedRequest | undefined {
    return this.bySession.get(sessionId);
  }

  /**
   * Drop one session's capture.
   * @param sessionId - session to forget.
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** Drop every capture. */
  clearAll(): void {
    this.bySession.clear();
  }
}
