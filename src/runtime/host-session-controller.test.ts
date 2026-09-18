import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

import { invoke } from "@tauri-apps/api/core";
import { createHostSession, openHostSession } from "./host-shadow";
import { sessionStartInput } from "./session-start";

describe("Host Session controller commands", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("requires a selected Codex connection and resumes without model overrides", async () => {
    const options = {
      runtimeProductId: "codex" as const,
      generation: 9,
      catalogModelId: "native-catalog-id",
      reasoningEffort: "native-effort",
    };
    expect(() => sessionStartInput("/tmp/project", options)).toThrow(
      "explicitly selected",
    );
    expect(
      sessionStartInput("/tmp/project", options, {
        installationId: "user-installation",
        connectionId: "private-connection",
      }),
    ).toEqual({
      installationId: "user-installation",
      connectionId: "private-connection",
      workingCopyPath: "/tmp/project",
      options,
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      navigation: {
        sessionIndex: { schemaVersion: 8, sessions: [] },
        restoreState: null,
      },
    });
    await openHostSession("bound-codex-session");
    expect(invoke).toHaveBeenCalledWith("host_session_open", {
      input: { farfoldSessionId: "bound-codex-session", options: null },
    });
  });

  it("rejects Pi new-session inputs without the ACP adapter", async () => {
    expect(() =>
      sessionStartInput("/tmp/project", {
        runtimeProductId: "pi",
        projectTrust: "approve",
      } as never),
    ).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("creates OpenCode Sessions from a Working Copy without a native Session input", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      farfoldSessionId: "session-2",
      runtimeProductId: "opencode",
      installationId: "bundled-opencode",
      nativeSessionId: "ses_native",
      runtimeGeneration: 5,
      openedAt: 11,
      navigation: {
        sessionIndex: { schemaVersion: 3, sessions: [] },
        restoreState: null,
      },
    });

    await expect(
      createHostSession(
        sessionStartInput(
          "/tmp/project",
          { runtimeProductId: "opencode" },
          {
            installationId: "registered-acp",
            connectionId: "managed-connection",
            adapterId: "opencode-acp-stdio-v1",
          },
        ),
      ),
    ).resolves.toMatchObject({ farfoldSessionId: "session-2" });
    expect(invoke).toHaveBeenCalledWith("host_session_create", {
      input: {
        installationId: "registered-acp",
        connectionId: "managed-connection",
        workingCopyPath: "/tmp/project",
        options: {
          runtimeProductId: "opencode",
          adapterId: "opencode-acp-stdio-v1",
        },
      },
    });
  });

  it("keeps the selected OpenCode ACP adapter on ordinary workspace creation", () => {
    expect(
      sessionStartInput(
        "/tmp/project",
        { runtimeProductId: "opencode" },
        {
          installationId: "system-opencode-acp",
          connectionId: "system-opencode-acp-connection",
          adapterId: "opencode-acp-stdio-v1",
        },
      ),
    ).toEqual({
      installationId: "system-opencode-acp",
      connectionId: "system-opencode-acp-connection",
      workingCopyPath: "/tmp/project",
      options: {
        runtimeProductId: "opencode",
        adapterId: "opencode-acp-stdio-v1",
      },
    });
  });

  it("rejects new Server sessions without changing legacy resume", async () => {
    const options = { runtimeProductId: "opencode" as const };
    expect(() => sessionStartInput("/tmp/project", options)).toThrow(
      "registered ACP",
    );
    expect(() =>
      sessionStartInput("/tmp/project", options, {
        installationId: "legacy",
        connectionId: "legacy",
        adapterId: "opencode-server-http-sse-v1",
      }),
    ).toThrow("registered ACP");
    vi.mocked(invoke).mockResolvedValueOnce({
      navigation: { sessionIndex: { sessions: [] }, restoreState: null },
    });
    await openHostSession("legacy-bound-session");
    expect(invoke).toHaveBeenCalledWith("host_session_open", {
      input: { farfoldSessionId: "legacy-bound-session", options: null },
    });
  });
});
