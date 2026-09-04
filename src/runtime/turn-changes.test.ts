import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  markTurnChangesReviewed,
  turnChangeReviewSnapshot,
} from "./turn-changes";

describe("Turn Changes Host commands", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("scopes reads and review acknowledgement to the exact Session and Turn", async () => {
    await turnChangeReviewSnapshot("session-1");
    await markTurnChangesReviewed("session-1", "turn-1");

    expect(invoke).toHaveBeenNthCalledWith(1, "turn_change_review_snapshot", {
      input: { farfoldSessionId: "session-1" },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "turn_change_review_mark", {
      input: { farfoldSessionId: "session-1", turnId: "turn-1" },
    });
  });
});
