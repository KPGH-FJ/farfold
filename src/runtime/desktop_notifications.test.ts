import { describe, expect, it, vi } from "vitest";
import {
  DesktopNotifications,
  NOTIFICATION_STRINGS,
} from "./desktop_notifications";
import {
  applyConnectionLost,
  applyElicitation,
  applyPermissionRequest,
  applyTurnEnd,
  freshThreadState,
} from "./session_projection";

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const saved = (enabled: boolean, sound = false) => ({
  enabled,
  sound,
  permission: "authorized",
  systemAlert: true,
  systemSound: true,
  clickRequiresRunning: false,
});
function fixture(enabled = true) {
  const read = vi.fn(async (): Promise<unknown> => saved(enabled));
  const save = vi.fn(async (value: boolean, sound: boolean): Promise<unknown> =>
    saved(value, sound),
  );
  const submit = vi.fn(
    async (
      _kind: string,
      _sequence: number,
      _targetKey: string,
      _rendererNonce: string,
    ) => "submitted",
  );
  const background = vi.fn(() => true);
  const notifications = new DesktopNotifications({
    read,
    save,
    submit,
    background,
  });
  const s = freshThreadState(
    "private-path-key",
    "private-agent",
    "/private-path",
    "private-id",
  );
  s.connectionId = "connection-1";
  s.title = "private conversation title";
  return { notifications, read, save, submit, background, s };
}
const approval = {
  kind: "permissionRequest",
  requestId: "approval-1",
  toolCall: { title: "secret command", toolCallId: "tool-1" },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
};
const question = {
  kind: "elicitation",
  requestId: "question-1",
  message: "private question",
};

describe("desktop reminder preferences", () => {
  it("keeps unavailable Windows banner and sound status unknown and states the running-only click scope", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({
      ...saved(true),
      systemAlert: null,
      systemSound: null,
      clickRequiresRunning: true,
    });
    await f.notifications.load();
    expect(f.notifications.snapshot()).toMatchObject({
      ready: true,
      enabled: true,
      systemAlert: null,
      systemSound: null,
      clickRequiresRunning: true,
      error: null,
    });
  });
  it("reports denied system permission without showing enabled and does not auto retry", async () => {
    const f = fixture(false);
    await f.notifications.load();
    f.save.mockResolvedValueOnce({ ...saved(false), permission: "denied" });
    await f.notifications.setEnabled(true);
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: false,
      permission: "denied",
      error: NOTIFICATION_STRINGS.permissionDenied,
    });
    await settle();
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      error: "系统通知许可尚未确认，请重新检查",
      message: NOTIFICATION_STRINGS.permissionUnknown,
    },
    {
      error: "系统通知暂不可用",
      message: "系统通知暂不可用。请稍后重新检查；提醒仍使用之前的选择。",
    },
  ])(
    "explains a fixed system-permission failure without changing saved choices or retrying: $error",
    async ({ error, message }) => {
      const f = fixture(false);
      f.read.mockResolvedValueOnce(saved(false, true));
      await f.notifications.load();
      f.save.mockRejectedValueOnce(error);
      await f.notifications.setEnabled(true);
      expect(f.notifications.snapshot()).toMatchObject({
        enabled: false,
        sound: true,
        permission: "authorized",
        saving: false,
        error: message,
      });
      await settle();
      expect(f.save).toHaveBeenCalledExactlyOnceWith(true, true);
      expect(f.submit).not.toHaveBeenCalled();
    },
  );

  it.each([
    "系统通知许可尚未确认，原设置保持不变",
    new Error("系统通知许可尚未确认，请重新检查"),
  ])(
    "recognizes only the exact known permission error when it is returned directly or as an Error: %j",
    async (error) => {
      const f = fixture(false);
      await f.notifications.load();
      f.save.mockRejectedValueOnce(error);
      await f.notifications.setEnabled(true);
      expect(f.notifications.snapshot()).toMatchObject({
        enabled: false,
        saving: false,
        error: NOTIFICATION_STRINGS.permissionUnknown,
      });
      expect(f.save).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "系统通知暂不可用：private-provider-details",
    "private-database-details",
    { message: "系统通知暂不可用", privateDetail: "private-value" },
  ])(
    "does not expose unknown or storage failures that resemble a permission error: %j",
    async (error) => {
      const f = fixture();
      await f.notifications.load();
      f.save.mockRejectedValueOnce(error);
      await f.notifications.setSound(true);
      expect(f.notifications.snapshot()).toMatchObject({
        enabled: true,
        sound: false,
        saving: false,
        error: NOTIFICATION_STRINGS.saveError,
      });
      await settle();
      expect(f.save).toHaveBeenCalledExactlyOnceWith(true, true);
      expect(f.submit).not.toHaveBeenCalled();
    },
  );

  it("stores a quiet default and keeps the explicit sound choice separate from system permission", async () => {
    const f = fixture(false);
    await f.notifications.load();
    expect(f.notifications.snapshot().sound).toBe(false);
    await f.notifications.setSound(true);
    expect(f.save).toHaveBeenCalledExactlyOnceWith(false, true);
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: false,
      sound: true,
    });
  });

  it("refreshes changed system settings without applying a late read over a newer user choice", async () => {
    const f = fixture(false);
    await f.notifications.load();
    const read = deferred<unknown>();
    f.read.mockReturnValueOnce(read.promise);
    const reading = f.notifications.load(true);
    await f.notifications.setEnabled(true);
    read.resolve({ ...saved(false), permission: "denied" });
    await reading;
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: true,
      permission: "authorized",
    });
  });
  it("starts off, stays off until read, and never writes a default on startup", async () => {
    const f = fixture(false);
    expect(f.notifications.snapshot().enabled).toBe(false);
    f.notifications.observe(f.s, approval, true);
    applyPermissionRequest(f.s, approval);
    await settle();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: false,
      ready: true,
    });
  });

  it("preserves unreadable records and requires a successful retry before allowing a write", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce({ enabled: true });
    await f.notifications.load();
    await f.notifications.setEnabled(true);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: false,
      ready: false,
      error: NOTIFICATION_STRINGS.loadError,
    });
    await f.notifications.load();
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: true,
      ready: true,
      error: null,
    });
  });

  it("serializes explicit changes, retains the original value on failure, then accepts a retry", async () => {
    const f = fixture();
    await f.notifications.load();
    const saving = deferred<unknown>();
    f.save.mockReturnValueOnce(saving.promise);
    const change = f.notifications.setEnabled(false);
    await f.notifications.setEnabled(false);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: true,
      saving: true,
    });
    saving.resolve(saved(false));
    await change;
    f.save.mockRejectedValueOnce(new Error("private database details"));
    await f.notifications.setEnabled(true);
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: false,
      saving: false,
      error: NOTIFICATION_STRINGS.saveError,
    });
    await f.notifications.setEnabled(true);
    expect(f.notifications.snapshot()).toMatchObject({
      enabled: true,
      error: null,
    });
  });

  it("does not let an in-flight reminder escape a new disable choice", async () => {
    const f = fixture();
    await f.notifications.load();
    f.notifications.observe(f.s, approval, true);
    applyPermissionRequest(f.s, approval);
    await f.notifications.setEnabled(false);
    await settle();
    expect(f.submit).not.toHaveBeenCalled();
  });
});

describe("live, content-free desktop reminders", () => {
  it("notifies a live browser approval once without requiring an Agent permission event", async () => {
    const f = fixture();
    f.s.browserReadRequestId = "browser-request";
    const current = () => true;
    f.notifications.observeBrowserRequest(f.s, "browser-request", current);
    f.notifications.observeBrowserRequest(f.s, "browser-request", current);
    await settle();
    expect(f.submit.mock.calls).toEqual([
      ["approval", 1, f.s.key, expect.stringMatching(/^[a-f0-9]{32}$/)],
    ]);
    expect(f.s.pendingPermissions).toEqual([]);
  });

  it.each(["cancelled", "owner-replaced", "disconnected", "foreground"])(
    "drops a %s browser approval before its asynchronous submission",
    async (change) => {
      const f = fixture();
      const reading = deferred<unknown>();
      f.read.mockReturnValueOnce(reading.promise);
      f.s.browserReadRequestId = "browser-request";
      let ownerCurrent = true;
      f.notifications.observeBrowserRequest(
        f.s,
        "browser-request",
        () => ownerCurrent,
      );
      await settle();
      if (change === "cancelled") f.s.browserReadRequestId = null;
      if (change === "owner-replaced") ownerCurrent = false;
      if (change === "disconnected") f.s.connectionLost = true;
      if (change === "foreground") f.background.mockReturnValue(false);
      reading.resolve(saved(true));
      await settle();
      expect(f.submit).not.toHaveBeenCalled();
    },
  );

  it("never turns a browser request seen in the foreground into a later background reminder", async () => {
    const f = fixture();
    f.s.browserReadRequestId = "browser-request";
    f.background.mockReturnValue(false);
    f.notifications.observeBrowserRequest(f.s, "browser-request", () => true);
    f.background.mockReturnValue(true);
    f.notifications.observeBrowserRequest(f.s, "browser-request", () => true);
    await settle();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("uses a fresh renderer identity after reload while retaining per-renderer sequence order", async () => {
    const first = fixture();
    const restarted = fixture();
    for (const f of [first, restarted]) {
      await f.notifications.load();
      f.notifications.observe(f.s, approval, true);
      applyPermissionRequest(f.s, approval);
      await settle();
    }
    expect(first.submit.mock.calls[0][1]).toBe(1);
    expect(restarted.submit.mock.calls[0][1]).toBe(1);
    expect(first.submit.mock.calls[0][3]).not.toBe(
      restarted.submit.mock.calls[0][3],
    );
  });
  it("sends once for a newly pending request and never includes its content or location", async () => {
    const f = fixture();
    await f.notifications.load();
    f.notifications.observe(f.s, approval, true);
    applyPermissionRequest(f.s, approval);
    f.notifications.observe(f.s, approval, true);
    await settle();
    f.notifications.observe(f.s, approval, true);
    await settle();
    expect(f.submit.mock.calls).toEqual([
      ["approval", 1, f.s.key, expect.stringMatching(/^[a-f0-9]{32}$/)],
    ]);
    f.notifications.observe(f.s, question, true);
    applyElicitation(f.s, question);
    await settle();
    expect(f.submit.mock.calls).toEqual([
      ["approval", 1, f.s.key, expect.stringMatching(/^[a-f0-9]{32}$/)],
      ["question", 2, f.s.key, expect.stringMatching(/^[a-f0-9]{32}$/)],
    ]);
    expect(JSON.stringify(f.submit.mock.calls)).not.toMatch(
      /private conversation title|secret command|private question|question-1/,
    );
  });

  it("does not notify history, ordinary output, an active window, or previously pending cards", async () => {
    const f = fixture();
    f.notifications.observe(f.s, approval, false);
    f.notifications.observe(
      f.s,
      { kind: "notification", params: { text: "secret" } },
      true,
    );
    f.notifications.observe(
      f.s,
      { update: { sessionUpdate: "agent_message_chunk" } },
      true,
    );
    f.background.mockReturnValue(false);
    f.notifications.observe(f.s, approval, true);
    applyPermissionRequest(f.s, approval);
    f.background.mockReturnValue(true);
    f.notifications.observe(f.s, approval, true);
    await settle();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["answered", "foreground", "new-connection"])(
    "discards %s reminders while the initial preference is loading",
    async (change) => {
      const f = fixture();
      const reading = deferred<unknown>();
      f.read.mockReturnValue(reading.promise);
      f.notifications.observe(f.s, question, true);
      applyElicitation(f.s, question);
      await settle();
      if (change === "answered") f.s.pendingElicitations = [];
      if (change === "foreground") f.background.mockReturnValue(false);
      if (change === "new-connection") f.s.connectionId = "connection-2";
      reading.resolve(saved(true));
      await settle();
      expect(f.submit).not.toHaveBeenCalled();
    },
  );

  it("reports an active unexpected loss once, but ignores idle and user-initiated closes", async () => {
    for (const reason of [
      "user",
      "idle",
      "shutdown",
      "configuration",
      "unexpected",
    ]) {
      const f = fixture();
      await f.notifications.load();
      const event = { kind: "connectionLost", closeReason: reason };
      f.notifications.observe(f.s, event, true);
      f.s.running = true;
      f.notifications.observe(f.s, event, true);
      applyConnectionLost(f.s, reason);
      f.notifications.observe(f.s, event, true);
      await settle();
      expect(f.submit).toHaveBeenCalledTimes(reason === "unexpected" ? 1 : 0);
    }
  });

  it.each(["end_turn", "cancelled", "refusal", "max_tokens", "future-result"])(
    "keeps %s distinct from successful completion",
    async (stopReason) => {
      const f = fixture();
      await f.notifications.load();
      f.s.running = true;
      const event = { kind: "turnEnd", stopReason };
      f.notifications.observe(f.s, event, true);
      applyTurnEnd(f.s, event);
      f.notifications.observe(f.s, event, true);
      await settle();
      expect(f.submit).toHaveBeenCalledTimes(
        ["end_turn", "cancelled"].includes(stopReason) ? 0 : 1,
      );
    },
  );

  it("does not retry a rejected submission or expose its error payload", async () => {
    const f = fixture();
    f.submit.mockRejectedValue(new Error("private OS payload"));
    f.notifications.observe(f.s, approval, true);
    applyPermissionRequest(f.s, approval);
    await settle();
    f.notifications.observe(f.s, approval, true);
    await settle();
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.notifications.snapshot().submissionError).toBe(
      NOTIFICATION_STRINGS.submitError,
    );
  });

  it("remembers an unknown outcome after submission and merges repeated abnormal receipts without losing new rounds", async () => {
    const f = fixture();
    await f.notifications.load();
    f.s.running = true;
    f.s.activeToolCallIds = ["still-running-tool"];
    const unknown = { kind: "turnEnd", stopReason: "unconfirmed" };
    f.notifications.observe(f.s, unknown, true);
    applyTurnEnd(f.s, unknown);
    await settle();
    f.notifications.observe(f.s, unknown, true);
    f.notifications.observe(f.s, { kind: "serviceUnavailable" }, true);
    await settle();
    expect(f.submit).toHaveBeenCalledTimes(1);
    f.s.roundItemBase = f.s.items.length;
    f.s.running = true;
    f.notifications.observe(f.s, unknown, true);
    applyTurnEnd(f.s, unknown);
    await settle();
    expect(f.submit).toHaveBeenCalledTimes(2);
    f.s.connectionId = "replacement";
    f.notifications.observe(f.s, unknown, true);
    await settle();
    expect(f.submit).toHaveBeenCalledTimes(3);
  });

  it("does not replay an abnormal foreground event after losing focus or enabling reminders", async () => {
    const f = fixture(false);
    await f.notifications.load();
    f.s.activeToolCallIds = ["unconfirmed"];
    const event = { kind: "turnEnd", stopReason: "unknown" };
    f.background.mockReturnValue(false);
    f.notifications.observe(f.s, event, true);
    f.background.mockReturnValue(true);
    await f.notifications.setEnabled(true);
    f.notifications.observe(f.s, event, true);
    await settle();
    expect(f.submit).not.toHaveBeenCalled();
  });
});
