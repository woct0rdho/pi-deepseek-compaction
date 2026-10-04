// Reader for Pi's own compaction settings. Pi remains the single owner of the
// thresholds. This module only exposes them for the summarize output cap and the
// status command.

import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiCompactionSettings } from "./types.ts";

export type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

// Read Pi's merged compaction settings from the extension API. Pi applies its
// own user/project merge, trust rules, and defaults. Per-compaction values come
// from `event.preparation.settings`.
export function loadPiCompactionSettings(settings: PiSettings): PiCompactionSettings {
  const compaction = settings.compaction;
  return {
    enabled: compaction?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: compaction?.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  };
}
