import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));

import { threads } from "./sessions";
import { desktopNotificationDiagnostic } from "./desktop_notifications";
import type { ThreadState } from "./session_types";

let serial = 0;
const channel = threads as unknown as {
  applyChannelEvent(key: string, event: unknown, live?: boolean): void;
};
function state(): ThreadState {
  const id = `reminder-channel-${++serial}`;
  const s = threads.markOpenFailed(
    id,
    "fixture-agent",
    "/private-project",
    id,
    "private-title",
  );
  s.connectionId = `connection-${serial}`;
  s.openError = null;
  return s;
}
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function permission(id: string) {
  return {
    kind: "permissionRequest",
    requestId: id,
    toolCall: { toolCallId: `private-${id}`, title: "private write command" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
}

beforeEach(() => {
  vi.stubGlobal("document", { hidden: true, hasFocus: () => false });
  invoke.mockImplementation(async (command: string) => {
    if (command === "desktop_notifications_get")
      return {
        enabled: true,
        sound: false,
        permission: "authorized",
        systemAlert: true,
        systemSound: true,
        clickRequiresRunning: false,
      };
    if (command === "desktop_notification_submit") return "submitted";
    return [];
  });
});
afterEach(() => {
  invoke.mockReset();
  vi.unstubAllGlobals();
});

describe("production channel desktop reminder flow", () => {
  it("observes the real pre-mutation state and submits only after its pending card has been projected", async () => {
    const s = state();
    const event = permission("live-private-request");
    channel.applyChannelEvent(s.key, event);
    expect(s.pendingPermissions).toMatchObject([
      { requestId: event.requestId, status: "pending" },
    ]);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "desktop_notification_submit",
      ),
    ).toHaveLength(0);
    await settle();
    const submitted = invoke.mock.calls.filter(
      ([command]) => command === "desktop_notification_submit",
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0][1]).toMatchObject({
      kind: "approval",
      targetKey: s.key,
    });
    expect(desktopNotificationDiagnostic()).toMatchObject({
      version: 1,
      frontend: {
        kind: "approval",
        source: "agent",
        phase: "submitted",
        background: true,
      },
      backendAttempt: {
        sequence: submitted[0][1].sequence,
        rendererNonce: submitted[0][1].rendererNonce,
      },
    });
    expect(JSON.stringify(desktopNotificationDiagnostic())).not.toMatch(
      /private-project|private-title|live-private-request|private write command|fixture-agent/,
    );
    channel.applyChannelEvent(s.key, event);
    await settle();
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "desktop_notification_submit",
      ),
    ).toHaveLength(1);
  });

  it("keeps historical and unknown envelopes out of the last live candidate diagnostic", async () => {
    const prior = desktopNotificationDiagnostic();
    const s = state();
    channel.applyChannelEvent(
      s.key,
      permission("history-private-request"),
      false,
    );
    channel.applyChannelEvent(s.key, {
      kind: "notification",
      method: "_future/status",
      params: { private: true },
    });
    expect(s.pendingPermissions).toHaveLength(1);
    await settle();
    expect(desktopNotificationDiagnostic()).toEqual(prior);
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "desktop_notification_submit",
      ),
    ).toHaveLength(0);
  });

  it("drops a production request synchronously cancelled before asynchronous submission", async () => {
    const s = state();
    channel.applyChannelEvent(s.key, permission("cancelled-private-request"));
    channel.applyChannelEvent(s.key, { kind: "interactionsCancelled" });
    await settle();
    expect(s.pendingPermissions).toHaveLength(0);
    expect(desktopNotificationDiagnostic()).toMatchObject({
      frontend: { kind: "approval", phase: "skipped", reason: "not_pending" },
      backendAttempt: null,
    });
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "desktop_notification_submit",
      ),
    ).toHaveLength(0);
  });
});
