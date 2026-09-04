import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  activateManagedUpdate,
  discardManagedUpdateRecovery,
  downloadManagedUpdate,
  requestManagedUpdateRollback,
} from "./managed-update";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("managed update transport", () => {
  beforeEach(() => invokeMock.mockReset());

  it("binds candidate mutations to the exact candidate token", async () => {
    invokeMock.mockResolvedValue({});
    await downloadManagedUpdate("candidate-token");
    await activateManagedUpdate("candidate-token");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "managed_update_download", {
      input: { expectedCandidateToken: "candidate-token" },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "managed_update_activate", {
      input: { expectedCandidateToken: "candidate-token" },
    });
  });

  it("keeps rollback and discard as separately confirmed authorities", async () => {
    invokeMock.mockResolvedValue({});
    await requestManagedUpdateRollback("operation-1", "ROLL BACK");
    await discardManagedUpdateRecovery("operation-1", "DISCARD");
    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "managed_update_request_rollback",
      {
        input: {
          expectedOperationId: "operation-1",
          confirmation: "ROLL BACK",
        },
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "managed_update_discard_recovery",
      {
        input: { expectedOperationId: "operation-1", confirmation: "DISCARD" },
      },
    );
  });
});
