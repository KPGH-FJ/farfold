import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  clearHostSessionDraft,
  getHostSessionDraft,
  setHostSessionDraft,
} from "./host-draft";

describe("Host Session draft commands", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("scopes read, committed write, and clear to the Farfold Session ID", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        farfoldSessionId: "session-1",
        body: "draft",
        updatedAt: 2,
      })
      .mockResolvedValueOnce({
        farfoldSessionId: "session-1",
        body: "updated",
        updatedAt: 3,
      })
      .mockResolvedValueOnce({ farfoldSessionId: "session-1", removed: true });

    await expect(getHostSessionDraft("session-1")).resolves.toMatchObject({
      body: "draft",
    });
    await expect(
      setHostSessionDraft("session-1", "updated"),
    ).resolves.toMatchObject({ body: "updated" });
    await expect(clearHostSessionDraft("session-1")).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, "session_draft_get", {
      farfoldSessionId: "session-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "session_draft_set", {
      input: { farfoldSessionId: "session-1", body: "updated" },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "session_draft_clear", {
      farfoldSessionId: "session-1",
    });
  });
});
