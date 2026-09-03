import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

import { invoke } from "@tauri-apps/api/core";
import { updateHostSessionMetadata } from "./host-session-metadata";

describe("Host Session metadata command", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

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
    expect(invoke).toHaveBeenNthCalledWith(1, "session_metadata_update", {
      input: { farfoldSessionId: "session-1", title: "Renamed" },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
