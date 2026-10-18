import { beforeEach, afterEach, expect, it } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { historyReads } from "./runtime/session_history_admission";
import { openingInquiries } from "./runtime/opening_inquiries";
import { freshThreadState } from "./runtime/session_projection";
import type { OpenInput } from "./runtime/session_open_input";

const row = {
  id: "A:/history:waiting",
  agentId: "A",
  cwd: "/history",
  nativeSessionId: "waiting",
};
let owner: ReturnType<typeof historyReads.begin>;
let inquiry: ReturnType<typeof openingInquiries.begin>;
let complete: (() => void) | undefined;
beforeEach(async () => {
  await resetHarness();
  h.invoke.mockClear();
  let resolve!: (value: unknown) => void;
  const pending = new Promise((finish) => (resolve = finish));
  complete = () => {
    historyReads.finish("app-opening", owner);
    inquiry?.finish();
    resolve(freshThreadState(row.id, "A", row.cwd, row.nativeSessionId));
  };
  h.open.mockImplementation((input: OpenInput) => {
    if (!owner) {
      owner = historyReads.begin("app-opening", input, "app-open-token");
      inquiry = openingInquiries.begin("app-opening", input);
    } else {
      historyReads.join("app-opening", input);
      openingInquiries.join(
        "app-opening",
        input.inquiryCurrent,
        input.inquirySignal,
      );
    }
    return pending;
  });
});
afterEach(async () => {
  complete?.();
  await Promise.resolve();
  cleanupHarness();
  owner = undefined;
  complete = undefined;
  openingInquiries.retireAll();
});
const waiting = () => {
  owner!.channel.onmessage({
    kind: "session_history_admission",
    openToken: owner!.token,
    phase: "waiting",
  });
};
const cancellations = () =>
  h.invoke.mock.calls.filter(
    ([name]) => name === "session_open_cancel_waiting",
  );

it("reselecting the same waiting row retains the shared read and a later actual inquiry", async () => {
  const open = component("ConversationLibrary").onOpen as (
    row: unknown,
  ) => void;
  open(row);
  waiting();
  open(row);
  render();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.open).toHaveBeenCalledTimes(2);
  expect(cancellations()).toEqual([]);
  expect(historyReads.getSnapshot()[0].phase).toBe("waiting");
  inquiry.receive({
    kind: "elicitation",
    requestId: "late-question",
    mode: "url",
    message: "A real protocol inquiry after reselect",
    url: "https://example.test/consent",
    owner: { connectionId: "owned-connection", requestId: 1 },
  });
  expect(inquiry.snapshot().requests).toHaveLength(1);
  expect(inquiry.snapshot().ended).toBe(false);
  expect(
    h.invoke.mock.calls.some(
      ([name]) => name === "session_elicitation_respond",
    ),
  ).toBe(false);
});

it("leaving for settings retires only the last interested queued caller", async () => {
  call("ConversationLibrary", "onOpen", row);
  waiting();
  h.invoke.mockImplementation(async (name) =>
    name === "session_open_cancel_waiting"
      ? { openToken: owner!.token, outcome: "cancelledWaiting" }
      : "/ordinary",
  );
  call("Sidebar", "onSettings");
  await Promise.resolve();
  await Promise.resolve();
  expect(cancellations()).toHaveLength(1);
  expect(cancellations()[0][1]).toEqual({ openToken: "app-open-token" });
  expect(inquiry.snapshot().ended).toBe(true);
  expect(historyReads.getSnapshot()[0].phase).toBe("cancelled");
});

it("unmounting the app removes its interest without pretending started work stopped", async () => {
  call("ConversationLibrary", "onOpen", row);
  owner!.channel.onmessage({
    kind: "session_history_admission",
    openToken: owner!.token,
    phase: "starting",
  });
  const input = h.open.mock.calls[0][0] as OpenInput;
  expect(input.inquirySignal!.aborted).toBe(false);
  cleanupHarness();
  await Promise.resolve();
  expect(input.inquirySignal!.aborted).toBe(true);
  expect(cancellations()).toEqual([]);
  expect(historyReads.getSnapshot()[0].phase).toBe("starting");
});
