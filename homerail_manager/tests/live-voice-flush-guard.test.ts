import { describe, expect, it } from "vitest";
import { shouldSyncLiveVoiceRunIds } from "../src/server/voice-agent-bootstrap.js";

/**
 * Regression coverage for issue #168 (reconnect clears the canvas owner).
 *
 * `flush_tool_state` writes the in-memory `createdRunIds` back to the persisted
 * workspace via `syncWorkspaceRunIds`. A fresh binding starts with whatever was
 * hydrated, but if a flush ever runs with an empty list (e.g. a reconnect before
 * any Manager tool has run), it would set `manager_run_id = null` and yank the
 * canvas to the canonical view. `shouldSyncLiveVoiceRunIds` encodes the guard:
 * an empty list must never overwrite an existing pointer.
 */
describe("shouldSyncLiveVoiceRunIds (issue #168 reconnect guard)", () => {
  it("refuses to sync an empty list (the reconnect-wipe guard)", () => {
    expect(shouldSyncLiveVoiceRunIds([])).toBe(false);
  });

  it("syncs a non-empty list", () => {
    expect(shouldSyncLiveVoiceRunIds(["run-1"])).toBe(true);
    expect(shouldSyncLiveVoiceRunIds(["run-1", "run-2"])).toBe(true);
  });

  it("treats a freshly-hydrated list as syncable", () => {
    // After hydration, createdRunIds mirrors the persisted workspace run ids;
    // a subsequent flush should still be allowed to write them.
    expect(shouldSyncLiveVoiceRunIds(["hydrated-run-1", "hydrated-run-2"])).toBe(true);
  });
});
