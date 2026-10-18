import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { historyReads } from "./session_history_admission";
import { HISTORY_READ as S } from "./history_read_strings";
import { HistoryReadStatus } from "../components/HistoryReadStatus";
import type { OpenInput } from "./session_open_input";

const owned: {
  key: string;
  owner: ReturnType<typeof historyReads.begin>;
}[] = [];
function begin(key: string, interest: Partial<OpenInput> = {}) {
  const owner = historyReads.begin(
    key,
    { agentId: "a", cwd: "/work", nativeSessionId: key, ...interest },
    `token-${key}`,
  )!;
  owned.push({ key, owner });
  return owner;
}
function phase(owner: ReturnType<typeof begin>, value: "waiting" | "starting") {
  owner.channel.onmessage({
    kind: "session_history_admission",
    openToken: owner.token,
    phase: value,
  });
}
async function microtasks() {
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  h.invoke.mockReset();
});
afterEach(() => {
  for (const { key, owner } of owned.splice(0)) historyReads.finish(key, owner);
  expect(historyReads.getSnapshot()).toEqual([]);
  vi.restoreAllMocks();
});

it("accepts only its separate typed progress token and never regresses starting", () => {
  const owner = begin("exact");
  const initial = historyReads.getSnapshot();
  for (const bad of [
    null,
    { kind: "session_history_admission", openToken: "other", phase: "waiting" },
    { kind: "notification", openToken: owner.token, phase: "starting" },
    {
      kind: "session_history_admission",
      openToken: owner.token,
      phase: { toString: () => "waiting" },
    },
  ])
    owner.channel.onmessage(bad);
  expect(historyReads.getSnapshot()).toBe(initial);
  phase(owner, "starting");
  phase(owner, "waiting");
  expect(historyReads.getSnapshot()[0].phase).toBe("starting");
  expect(h.invoke).not.toHaveBeenCalled();
});

it("one departing caller releases its listener without cancelling a shared survivor", async () => {
  const a = new AbortController(),
    b = new AbortController(),
    removed = vi.spyOn(a.signal, "removeEventListener");
  const owner = begin("shared", { inquirySignal: a.signal });
  historyReads.join("shared", { inquirySignal: b.signal });
  phase(owner, "waiting");
  a.abort();
  await microtasks();
  expect(removed).toHaveBeenCalledTimes(1);
  expect(h.invoke).not.toHaveBeenCalled();
  h.invoke.mockResolvedValue({
    openToken: owner.token,
    outcome: "cancelledWaiting",
  });
  b.abort();
  await microtasks();
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "session_open_cancel_waiting",
    {
      openToken: owner.token,
    },
  );
  expect(historyReads.getSnapshot()[0].phase).toBe("cancelled");
  historyReads.finish("shared", owner);
  expect(removed).toHaveBeenCalledTimes(1);
});

it("a same-commit joining caller survives an old interest abort", async () => {
  const a = new AbortController(),
    b = new AbortController();
  const owner = begin("joined", { inquirySignal: a.signal });
  phase(owner, "waiting");
  a.abort();
  queueMicrotask(() => historyReads.retireUninterested());
  historyReads.join("joined", { inquirySignal: b.signal });
  await microtasks();
  expect(h.invoke).not.toHaveBeenCalled();
  expect(historyReads.getSnapshot()[0].phase).toBe("waiting");
});

it("last-interest abandonment before registration waits for the matching queued acknowledgement", async () => {
  const a = new AbortController();
  a.abort();
  const owner = begin("not-registered", { inquirySignal: a.signal });
  await microtasks();
  expect(h.invoke).not.toHaveBeenCalled();
  h.invoke.mockResolvedValue({
    openToken: owner.token,
    outcome: "cancelledWaiting",
  });
  phase(owner, "waiting");
  await microtasks();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  expect(historyReads.getSnapshot()[0].notice).toBe(S.cancelled);
});

it("starting work never receives a stop or cancel-waiting request on caller departure", async () => {
  const a = new AbortController();
  const owner = begin("already-started", { inquirySignal: a.signal });
  phase(owner, "starting");
  a.abort();
  await microtasks();
  await historyReads.cancel(owner.token);
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(["notFound", "wrongToken", "rejected"])(
  "an %s cancellation response is unconfirmed and never resubmits the open",
  async (outcome) => {
    const owner = begin(outcome);
    phase(owner, "waiting");
    if (outcome === "rejected") h.invoke.mockRejectedValue(Error("controlled"));
    else
      h.invoke.mockResolvedValue({
        openToken: outcome === "wrongToken" ? "other" : owner.token,
        outcome: "notFound",
      });
    await historyReads.cancel(owner.token);
    expect(historyReads.getSnapshot()[0]).toMatchObject({
      phase: "waiting",
      cancelling: false,
      notice: S.unconfirmed,
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0][0]).toBe("session_open_cancel_waiting");
  },
);

it("a grant racing cancellation never becomes a false cancelled state", async () => {
  const owner = begin("racing");
  phase(owner, "waiting");
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const cancelling = historyReads.cancel(owner.token);
  expect(historyReads.getSnapshot()[0].cancelling).toBe(true);
  phase(owner, "starting");
  finish({ openToken: owner.token, outcome: "alreadyStarting" });
  await cancelling;
  phase(owner, "waiting");
  expect(historyReads.getSnapshot()[0]).toMatchObject({
    phase: "starting",
    cancelling: false,
    notice: undefined,
  });
});

it("finish releases interest listeners and ignores late progress or cancellation replies", async () => {
  const a = new AbortController();
  const removed = vi.spyOn(a.signal, "removeEventListener");
  const owner = begin("closed", { inquirySignal: a.signal });
  phase(owner, "waiting");
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const cancelling = historyReads.cancel(owner.token);
  historyReads.finish("closed", owner);
  phase(owner, "starting");
  a.abort();
  finish({ openToken: owner.token, outcome: "cancelledWaiting" });
  await cancelling;
  expect(removed).toHaveBeenCalledTimes(1);
  expect(historyReads.getSnapshot()).toEqual([]);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("shows cancellation only for the active target while its queued receipt is pending", async () => {
  const owner = begin("visible");
  const html = (target = "a:/work:visible", active = true) =>
    renderToStaticMarkup(<HistoryReadStatus target={target} active={active} />);
  expect(html()).toContain(S.preparing);
  expect(html()).not.toContain(S.cancel);
  phase(owner, "waiting");
  expect(html()).toContain('role="status"');
  expect(html()).toContain(S.cancel);
  expect(html("another")).toBe("");
  expect(html(undefined, false)).toBe("");
  expect(html()).not.toContain(owner.token);
  let finish!: (value: unknown) => void;
  h.invoke.mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const cancelling = historyReads.cancel(owner.token);
  expect(html()).toContain(S.cancelling);
  expect(html()).toContain("disabled");
  finish({ openToken: owner.token, outcome: "alreadyStarting" });
  await cancelling;
  expect(html()).toContain(S.starting);
  expect(html()).not.toContain("<button");
});
