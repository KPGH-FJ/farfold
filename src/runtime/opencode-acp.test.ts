import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

import { invoke } from "@tauri-apps/api/core";
import { respondToOpenCodeAcpPermission } from "./opencode-acp";

describe("OpenCode ACP host bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends Runtime generation with native permission replies", async () => {
    await respondToOpenCodeAcpPermission({
      farfoldSessionId: "session-1",
      nativeSessionId: "ses_1",
      runtimeGeneration: 7,
      requestId: "agent-permission-1",
      optionId: "allow-once",
    });

    expect(invoke).toHaveBeenCalledWith("opencode_acp_permission_respond", {
      input: {
        farfoldSessionId: "session-1",
        nativeSessionId: "ses_1",
        runtimeGeneration: 7,
        requestId: "agent-permission-1",
        optionId: "allow-once",
      },
    });
  });
});
