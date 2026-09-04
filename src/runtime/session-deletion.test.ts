import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  deleteSessionMetadata,
  previewSessionDeletion,
  type SessionDeletionPreview,
} from "./host-shadow";

describe("Session metadata deletion commands", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("keeps preview and exact typed identity confirmation separate", async () => {
    const preview = {
      farfoldSessionId: "session-1",
      confirmationToken: "delete-token",
    } as SessionDeletionPreview;

    await previewSessionDeletion(preview.farfoldSessionId);
    await deleteSessionMetadata(preview);

    expect(invoke).toHaveBeenNthCalledWith(1, "session_deletion_preview", {
      farfoldSessionId: "session-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "session_metadata_delete", {
      input: {
        farfoldSessionId: "session-1",
        expectedConfirmationToken: "delete-token",
        confirmFarfoldSessionId: "session-1",
      },
    });
  });
});
