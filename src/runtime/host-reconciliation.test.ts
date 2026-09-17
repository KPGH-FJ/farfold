import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import { reconcilePiHostSession } from "./host-shadow";

describe("Host Runtime reconciliation commands", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  it("uses the purpose-scoped Pi command", async () => {
    await reconcilePiHostSession();
    expect(invoke).toHaveBeenCalledWith("reconcile_pi_session");
  });
});
