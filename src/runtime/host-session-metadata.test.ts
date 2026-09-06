import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

import { invoke } from "@tauri-apps/api/core";
import {
  focusHostSession,
  updateHostSessionMetadata,
} from "./host-session-metadata";

describe("Host Session metadata command", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("persists selection without sending a Runtime lifecycle command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      sessionIndex: { schemaVersion: 3, sessions: [] },
      restoreState: {
        lastSessionId: "session-2",
        lastProjectId: "project-1",
        updatedAt: 3,
      },
    });
    await focusHostSession("session-2");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("host_session_focus", {
      farfoldSessionId: "session-2",
    });
  });

  it("acknowledges metadata only after refreshing committed navigation", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      metadata: {
        farfoldSessionId: "session-1",
        title: "Renamed",
        titleSource: "manual",
        pinned: false,
        archivedAt: null,
        updatedAt: 2,
      },
      navigation: {
        sessionIndex: { schemaVersion: 3, sessions: [] },
        restoreState: null,
      },
    });

    await expect(
      updateHostSessionMetadata({
        farfoldSessionId: "session-1",
        title: "Renamed",
      }),
    ).resolves.toMatchObject({ title: "Renamed" });
    expect(invoke).toHaveBeenNthCalledWith(1, "host_session_metadata_update", {
      input: { farfoldSessionId: "session-1", title: "Renamed" },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
