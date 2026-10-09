import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));
import { threads } from "./sessions";
import { OpeningInquiryOwner, openingInquiries } from "./opening_inquiries";
import { INQUIRY } from "./elicitation_strings";
import { STRINGS } from "./strings";
const question = {
  kind: "elicitation",
  requestId: "ask",
  mode: "url",
  message: "Go",
  url: "https://example.test/consent",
  owner: { connectionId: "connection", requestId: 12 },
};
afterEach(() => {
  openingInquiries.retireAll();
  h.invoke.mockReset();
  h.open.mockReset();
});
it("presents the actual pending session_open inquiry before that command resolves", async () => {
  let resolve!: (v: unknown) => void;
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_open") {
      args.channel.onmessage(question);
      return new Promise((r) => {
        resolve = r;
      });
    }
    return Promise.resolve([]);
  });
  const opening = threads.open({
    agentId: "opening-inquiry",
    cwd: "/controlled",
    fresh: true,
  });
  try {
    expect(
      openingInquiries.getSnapshot().flatMap((o) => o.requests),
    ).toHaveLength(1);
    expect(
      [...threads.getSnapshot().threads.values()].some(
        (s) => s.agentId === "opening-inquiry",
      ),
    ).toBe(false);
  } finally {
    resolve({ cwd: "/controlled", nativeSessionId: "opened" });
    await opening;
  }
});
it("keeps body/replay events out of the opening inquiry owner", () => {
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest();
  expect(
    owner.receive({ update: { sessionUpdate: "agent_message_chunk" } }),
  ).toBe(false);
  expect(owner.snapshot().requests).toEqual([]);
});
it("shows an unavailable inquiry while preserving normal channel delivery", () => {
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest();
  const params = { mode: "future", message: "Unrecognized question" };
  const consumed = owner.receive({ kind: "elicitationUnavailable", params });
  expect(owner.snapshot()).toMatchObject({
    notice: INQUIRY.unavailable,
    details: params,
    requests: [],
  });
  expect(consumed).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("retains unavailable details and the queue pause when an opening completes", async () => {
  let resolve!: (v: unknown) => void;
  const params = { mode: "future", message: "Unrecognized opening question" };
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_open") {
      args.channel.onmessage({ kind: "elicitationUnavailable", params });
      return new Promise((r) => {
        resolve = r;
      });
    }
    return Promise.resolve([]);
  });
  const opening = threads.open({
    agentId: "opening-unsupported-inquiry",
    cwd: "/controlled",
    fresh: true,
  });
  try {
    expect(
      openingInquiries
        .getSnapshot()
        .find((view) => view.agentId === "opening-unsupported-inquiry"),
    ).toMatchObject({ notice: INQUIRY.unavailable, details: params });
  } finally {
    resolve({ cwd: "/controlled", nativeSessionId: "unsupported-opened" });
  }
  const state = await opening;
  expect(state.queuePaused).toBe("unavailable");
  expect(state.items).toContainEqual(
    expect.objectContaining({
      kind: "raw",
      label: STRINGS.repair.unsupportedInquiry,
      update: params,
    }),
  );
  expect(
    h.invoke.mock.calls.some(([command]) =>
      ["session_elicitation_respond", "session_prompt"].includes(command),
    ),
  ).toBe(false);
});
it("cancellation during a pending browser open prevents late consent", async () => {
  let opened!: () => void;
  h.open.mockReturnValue(
    new Promise<void>((r) => {
      opened = r;
    }),
  );
  h.invoke.mockResolvedValue({ status: "submitted" });
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest();
  owner.receive(question);
  const answering = owner.reply("ask", "accept");
  owner.retire();
  opened();
  await answering;
  expect(h.invoke.mock.calls.map((c) => c[1].action)).toEqual(["cancel"]);
  expect(owner.snapshot().requests).toEqual([]);
});
it("invalidated preparation cannot answer or open a late URL", async () => {
  h.invoke.mockResolvedValue({ status: "submitted" });
  let current = true;
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest(() => current);
  owner.receive(question);
  current = false;
  await owner.reply("ask", "accept");
  expect(h.open).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
  owner.receive({ ...question, requestId: "later" });
  expect(h.invoke.mock.calls[0][1].action).toBe("cancel");
});
it("unknown or duplicate completion never consumes another opening inquiry", () => {
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest();
  owner.receive(question);
  expect(
    owner.receive({ kind: "elicitationComplete", requestId: "other" }),
  ).toBe(false);
  expect(owner.receive({ kind: "elicitationComplete", requestId: "ask" })).toBe(
    true,
  );
  expect(owner.snapshot().ended).toBe(false);
  expect(owner.snapshot().notice).toContain("原操作");
  expect(owner.receive({ kind: "elicitationComplete", requestId: "ask" })).toBe(
    false,
  );
});

it("aborting an opening removes its questions and prevents a late browser result even if a caller joins", async () => {
  const signal = new AbortController();
  let resolve!: () => void;
  h.open.mockReturnValue(
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  h.invoke.mockResolvedValue({ status: "submitted" });
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest(undefined, signal.signal);
  owner.receive(question);
  const reply = owner.reply("ask", "accept");
  signal.abort();
  owner.addInterest();
  resolve();
  await reply;
  expect(h.invoke).not.toHaveBeenCalled();
});
it("an abandoned last caller clears its questions without treating cancellation delivery as completion", async () => {
  h.invoke.mockResolvedValue({ status: "uncertain" });
  const abort = new AbortController();
  const owner = new OpeningInquiryOwner("a", "/p", () => {});
  owner.addInterest(undefined, abort.signal);
  owner.receive(question);
  abort.abort();
  await Promise.resolve();
  expect(owner.snapshot().requests).toEqual([]);
  expect(owner.snapshot().notice).toContain("仍待确认");
  expect(h.invoke.mock.calls[0][1].action).toBe("cancel");
});
it("two parallel openings cannot consume or answer each other's inquiry", async () => {
  h.invoke.mockResolvedValue({ status: "submitted" });
  h.open.mockResolvedValue(undefined);
  const one = new OpeningInquiryOwner("a", "/one", () => {});
  one.addInterest();
  const two = new OpeningInquiryOwner("a", "/two", () => {});
  two.addInterest();
  one.receive(question);
  two.receive({
    ...question,
    requestId: "ask-two",
    owner: { connectionId: "second", requestId: 12 },
  });
  expect(two.receive({ kind: "elicitationComplete", requestId: "ask" })).toBe(
    false,
  );
  one.finish(true);
  await one.reply("ask", "accept");
  await two.reply("ask-two", "decline");
  expect(h.invoke.mock.calls).toHaveLength(1);
  expect(h.invoke.mock.calls[0][1].requestOwner.connectionId).toBe("second");
});
