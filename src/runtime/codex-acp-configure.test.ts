import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  checkedCodexConfigure,
  CodexConfigurePrivateView,
  requestCodexAcpConfigure,
  type CodexConfigureCommand,
} from "./codex-acp-configure";
import type {
  CodexAcpConfigureSnapshot,
  CodexAcpScope,
} from "./codex-acp-contract";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ipc = vi.mocked(invoke);
const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "install",
  runtimeBuildId: "build",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "adapter",
  connectionId: "connection",
  profileId: "profile",
  generation: 1,
};
function snapshot(
  overrides: Partial<CodexAcpConfigureSnapshot> = {},
): CodexAcpConfigureSnapshot {
  return {
    scope,
    operationId: 1,
    phase: "starting",
    loginId: null,
    credentialState: "not_attempted",
    accountState: "unconfirmed",
    payload: null,
    ...overrides,
  };
}
const receipt = (s: CodexAcpConfigureSnapshot) => ({
  kind: "configure",
  snapshot: s,
});
const waiting = () =>
  snapshot({
    phase: "waiting",
    loginId: "login-1",
    payload: {
      type: "browser",
      authUrl: "https://auth.openai.com/SYNTHETIC-URL",
    },
  });
const status = (s: CodexAcpConfigureSnapshot): CodexConfigureCommand => ({
  action: "status",
  operationId: s.operationId,
  loginId: s.loginId,
});
function owner(allowed = true) {
  return new CodexConfigurePrivateView(scope, () => ({
    allowed,
    current: () => true,
    request: requestCodexAcpConfigure,
    discover: async () => ({
      kind: "configure_discovery",
      discovery: { scope, operation: null },
    }),
  }));
}
beforeEach(() => ipc.mockReset());

describe("private Codex Configure boundary", () => {
  it("uses the registered typed command without old login or draft/event IPC", async () => {
    ipc.mockResolvedValue(receipt(snapshot()));
    const view = owner();
    await view.discover();
    await view.request("api_key", "SYNTHETIC-ONLY");
    expect(ipc).toHaveBeenCalledExactlyOnceWith("host_codex_acp_operation", {
      input: {
        action: "configure",
        scope,
        command: { action: "api_key", key: "SYNTHETIC-ONLY" },
      },
    });
    expect(JSON.stringify(view.getSnapshot())).not.toContain("SYNTHETIC-ONLY");
  });
  it("keeps production presentation closed with zero IPC", async () => {
    const view = owner(false);
    await view.request("browser");
    await view.request("api_key", "SYNTHETIC-ONLY");
    expect(ipc).not.toHaveBeenCalled();
    expect(view.getSnapshot().snapshot).toBeNull();
  });
  it("checks every scope field, original operation and once-exposed login identity", () => {
    const previous = waiting();
    for (const field of Object.keys(scope)) {
      expect(() =>
        checkedCodexConfigure(
          receipt(
            snapshot({
              ...previous,
              scope: {
                ...scope,
                [field]: field === "generation" ? 2 : "foreign",
              },
            }),
          ),
          scope,
          status(previous),
          previous,
          "browser",
        ),
      ).toThrow();
    }
    for (const change of [
      { operationId: 2 },
      { loginId: "foreign" },
      { loginId: null },
    ])
      expect(() =>
        checkedCodexConfigure(
          receipt(snapshot({ ...previous, ...change })),
          scope,
          status(previous),
          previous,
          "browser",
        ),
      ).toThrow();
    const start = snapshot();
    expect(
      checkedCodexConfigure(
        receipt(previous),
        scope,
        status(start),
        start,
        "browser",
      ).loginId,
    ).toBe("login-1");
  });
  it("rejects unsafe URLs, device mismatch, missing identity and non-waiting instructions", () => {
    for (const url of [
      "http://auth.openai.com/",
      "https://evil.test/",
      "https://user:pass@auth.openai.com/",
      "https://auth.openai.com:8080/",
    ]) {
      const s = waiting();
      s.payload = { type: "browser", authUrl: url };
      expect(() =>
        checkedCodexConfigure(
          receipt(s),
          scope,
          { action: "browser" },
          null,
          "browser",
        ),
      ).toThrow();
    }
    expect(() =>
      checkedCodexConfigure(
        receipt(waiting()),
        scope,
        { action: "device" },
        null,
        "device",
      ),
    ).toThrow();
    expect(() =>
      checkedCodexConfigure(
        receipt(snapshot({ ...waiting(), phase: "confirmed" })),
        scope,
        { action: "browser" },
        null,
        "browser",
      ),
    ).toThrow();
    expect(() =>
      checkedCodexConfigure(
        receipt(snapshot({ ...waiting(), loginId: null })),
        scope,
        { action: "browser" },
        null,
        "browser",
      ),
    ).toThrow();
  });
  it("withdraws instructions immediately on cancel, with original IDs and no rollback claim", async () => {
    ipc.mockResolvedValueOnce(receipt(waiting()));
    const view = owner();
    await view.discover();
    await view.request("browser");
    let release!: (v: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = view.request("cancel");
    expect(view.getSnapshot().snapshot?.payload).toBeNull();
    expect(view.getSnapshot().busy).toBe(true);
    expect(ipc.mock.calls[1][1]).toEqual({
      input: {
        action: "configure",
        scope,
        command: { action: "cancel", operationId: 1, loginId: "login-1" },
      },
    });
    release(
      receipt(
        snapshot({
          ...waiting(),
          phase: "unknown",
          payload: null,
          credentialState: "unknown",
        }),
      ),
    );
    await pending;
    await view.request("browser");
    expect(ipc).toHaveBeenCalledTimes(2);
    expect(view.getSnapshot().snapshot?.phase).toBe("unknown");
  });
  it("retires private snapshots and late successes/errors on leave and same-view reentry", async () => {
    const view = owner();
    await view.discover();
    ipc.mockResolvedValueOnce(receipt(waiting()));
    await view.request("browser");
    let release!: (v: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = view.request("status");
    view.retire();
    view.activate();
    release(receipt(waiting()));
    await pending;
    expect(view.getSnapshot()).toEqual({
      snapshot: null,
      busy: false,
      error: null,
      checked: false,
    });
    let fail!: (e: unknown) => void;
    ipc.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    await view.discover();
    const next = view.request("browser");
    view.retire();
    fail(new Error("PRIVATE-ERROR"));
    await next;
    expect(JSON.stringify(view.getSnapshot())).not.toContain("PRIVATE");
  });
  it("redacts errors, clears instructions and blocks automatic reauthentication", async () => {
    ipc.mockResolvedValueOnce(receipt(waiting()));
    const view = owner();
    await view.discover();
    await view.request("browser");
    ipc.mockRejectedValueOnce(new Error("SYNTHETIC-SECRET-ECHO"));
    await view.request("status");
    expect(view.getSnapshot().snapshot?.phase).toBe("unknown");
    expect(view.getSnapshot().snapshot?.payload).toBeNull();
    expect(JSON.stringify(view.getSnapshot())).not.toContain("SECRET-ECHO");
    await view.request("api_key", "SYNTHETIC-ONLY");
    expect(ipc).toHaveBeenCalledTimes(2);
  });
  it("cannot use a past terminal result to validate a new operation's false confirmation", () => {
    const previous = snapshot({
      phase: "confirmed",
      credentialState: "committed",
      accountState: "api_key",
    });
    expect(() =>
      checkedCodexConfigure(
        receipt(snapshot({ operationId: 2, phase: "confirmed" })),
        scope,
        { action: "browser" },
        previous,
        "browser",
      ),
    ).toThrow();
  });
  it("does not revive withdrawn or terminal instructions within the same operation", () => {
    for (const phase of ["canceled", "unknown", "canceling"] as const) {
      const previous = snapshot({ ...waiting(), phase, payload: null });
      expect(() =>
        checkedCodexConfigure(
          receipt(waiting()),
          scope,
          status(previous),
          previous,
          "browser",
        ),
      ).toThrow();
    }
    expect(() =>
      checkedCodexConfigure(
        receipt(waiting()),
        scope,
        { action: "cancel", operationId: 1, loginId: "login-1" },
        waiting(),
        "browser",
      ),
    ).toThrow();
  });
});
