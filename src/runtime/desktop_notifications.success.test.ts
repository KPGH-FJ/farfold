import { expect, it, vi } from "vitest";
import {
  DesktopNotifications,
  NOTIFICATION_STRINGS,
} from "./desktop_notifications";
import {
  applyTurnEnd,
  applyUpdate,
  freshThreadState,
} from "./session_projection";

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const saved = (enabled = false, successEnabled = true, sound = false) => ({
  enabled,
  successEnabled,
  sound,
  permission: "authorized",
  systemAlert: true,
  systemSound: true,
  clickRequiresRunning: false,
});
function fixture() {
  const read = vi.fn(async (): Promise<unknown> => saved());
  const save = vi.fn(
    async (
      enabled: boolean,
      sound: boolean,
      successEnabled: boolean,
    ): Promise<unknown> => saved(enabled, successEnabled, sound),
  );
  const submit = vi.fn(async () => "submitted");
  const background = vi.fn(() => true);
  const withdraw = vi.fn(async (): Promise<unknown> => ({
    state: "withdrawn",
  }));
  const n = new DesktopNotifications({
    read,
    save,
    submit,
    background,
    withdraw,
  });
  const s = freshThreadState("key", "agent", "/own", "native");
  s.connectionId = "c";
  s.running = true;
  n.beginSuccess(s, () => true);
  const end = () => {
    applyUpdate(s, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Result" },
    });
    n.observe(s, { kind: "turnEnd", stopReason: "end_turn" }, true);
    applyTurnEnd(s, { stopReason: "end_turn" });
  };
  return { n, s, read, save, submit, background, withdraw, end };
}
it("success-only submits one content-free success without enabling attention reminders", async () => {
  const f = fixture();
  f.end();
  await tick();
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.submit.mock.calls[0]).toEqual([
    "success",
    1,
    "key",
    expect.stringMatching(/^[a-f0-9]{32}$/),
  ]);
  expect(f.n.diagnostic().frontend).toMatchObject({
    kind: "success",
    enabled: true,
    phase: "submitted",
  });
  expect(f.n.snapshot().enabled).toBe(false);
});
it("saves independent choices and shared sound without changing the other switch", async () => {
  const f = fixture();
  await f.n.load();
  await f.n.setEnabled(true);
  expect(f.save).toHaveBeenLastCalledWith(true, false, true);
  await f.n.setSuccessEnabled(false);
  expect(f.save).toHaveBeenLastCalledWith(true, false, false);
  await f.n.setSound(true);
  expect(f.save).toHaveBeenLastCalledWith(true, true, false);
});
it("fails closed on a missing required success field without default-writing or enabling either group", async () => {
  const f = fixture();
  const value = saved();
  const { successEnabled: _, ...missing } = value;
  f.read.mockResolvedValue(missing);
  await f.n.load();
  await f.n.setSuccessEnabled(true);
  expect(f.n.snapshot()).toMatchObject({
    enabled: false,
    successEnabled: false,
    error: NOTIFICATION_STRINGS.loadError,
  });
  expect(f.save).not.toHaveBeenCalled();
});
it("explicitly disables success while retaining attention under unknown system status", async () => {
  const f = fixture();
  f.read.mockResolvedValue(saved(true, true));
  await f.n.load();
  f.save.mockResolvedValue({
    ...saved(true, false),
    permission: "unknown",
    systemAlert: null,
    systemSound: null,
  });
  await f.n.setSuccessEnabled(false);
  expect(f.n.snapshot()).toMatchObject({
    enabled: true,
    successEnabled: false,
    error: null,
  });
});
it.each(["disabled", "foreground"])(
  "does not replay a %s success when conditions later change",
  async (reason) => {
    const f = fixture();
    if (reason === "disabled") f.read.mockResolvedValue(saved(false, false));
    else f.background.mockReturnValue(false);
    f.end();
    await tick();
    expect(f.submit).not.toHaveBeenCalled();
    f.background.mockReturnValue(true);
    await f.n.load();
    await f.n.setSuccessEnabled(true);
    f.n.checkSuccess(f.s);
    await tick();
    expect(f.submit).not.toHaveBeenCalled();
  },
);
it("new work while preferences load invalidates a formerly successful ending", async () => {
  const f = fixture();
  let resolve!: (v: unknown) => void;
  f.read.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  f.end();
  await tick();
  f.s.running = true;
  f.s.roundItemBase = f.s.items.length;
  f.n.beginSuccess(f.s, () => true);
  resolve(saved());
  await tick();
  expect(f.submit).not.toHaveBeenCalled();
});
it("permission/read failures preserve choices and never automatically retry an unknown submission", async () => {
  const f = fixture();
  await f.n.load();
  f.save.mockRejectedValue("系统通知许可尚未确认，原设置保持不变");
  await f.n.setEnabled(true);
  expect(f.n.snapshot()).toMatchObject({
    enabled: false,
    successEnabled: true,
  });
  f.submit.mockRejectedValue(new Error("unknown"));
  f.end();
  await tick();
  f.n.checkSuccess(f.s);
  await tick();
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.n.snapshot().submissionError).toBe(NOTIFICATION_STRINGS.submitError);
});

it.each(["stopping", "failed-tool", "connection-unknown"])(
  "withdraws a queued success when actual state becomes %s and does not resubmit it",
  async (change) => {
    const f = fixture();
    let release!: (value: string) => void;
    f.submit.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    f.end();
    await tick();
    expect(f.submit).toHaveBeenCalledTimes(1);
    if (change === "stopping") f.s.stopping = true;
    else if (change === "failed-tool")
      applyUpdate(f.s, {
        sessionUpdate: "tool_call",
        toolCallId: "late-tool",
        kind: "execute",
        status: "failed",
      });
    else f.s.connectionOutcomeUnknown = true;
    f.n.checkSuccess(f.s);
    await tick();
    const call = f.submit.mock.calls[0] as unknown as [
      string,
      number,
      string,
      string,
    ];
    expect(f.withdraw).toHaveBeenCalledExactlyOnceWith(call[3], call[1]);
    expect(f.n.diagnostic().frontend).toMatchObject({
      phase: "suppressed",
      reason: "not_pending",
    });
    release("suppressed");
    await tick();
    f.s.stopping = false;
    f.n.checkSuccess(f.s);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.withdraw).toHaveBeenCalledTimes(1);
  },
);
it("a timed-out submit remains retractable on owner retirement, without automatic submission retry", async () => {
  const f = fixture();
  f.submit.mockRejectedValue(new Error("unconfirmed"));
  f.end();
  await tick();
  expect(f.n.diagnostic().frontend.phase).toBe("unconfirmed");
  expect(f.withdraw).not.toHaveBeenCalled();
  f.s.connectionId = "replacement";
  f.n.checkSuccess();
  await tick();
  expect(f.withdraw).toHaveBeenCalledTimes(1);
  expect(f.submit).toHaveBeenCalledTimes(1);
});
it.each(["alreadySubmitted", "unknown", "invalid"])(
  "does not turn %s withdrawal into proof that a notification was suppressed",
  async (state) => {
    const f = fixture();
    let release!: (value: string) => void;
    f.submit.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    f.withdraw.mockResolvedValue({ state });
    f.end();
    await tick();
    f.s.connectionLost = true;
    f.n.checkSuccess();
    await tick();
    expect(f.n.diagnostic().frontend.phase).not.toBe("suppressed");
    release("submitted");
    await tick();
    expect(f.n.diagnostic().frontend.phase).toBe("submitted");
  },
);
it("ordinary visibility changes do not retire the work owner; the platform separately gates foreground delivery", async () => {
  const f = fixture();
  let release!: (value: string) => void;
  f.submit.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  f.end();
  await tick();
  f.background.mockReturnValue(false);
  f.n.checkSuccess();
  expect(f.withdraw).not.toHaveBeenCalled();
  release("suppressed");
  await tick();
  expect(f.n.diagnostic().frontend.phase).toBe("suppressed");
});
