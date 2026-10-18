import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.open }));

import { OpeningInquiryOwner } from "./opening_inquiries";
import { INQUIRY } from "./elicitation_strings";

const question = {
  kind: "elicitation",
  requestId: "owned-question",
  mode: "url",
  message: "Public controlled question",
  url: "https://example.test/consent",
  owner: { connectionId: "owned-connection", requestId: 12 },
};

const owners: OpeningInquiryOwner[] = [];
function owner() {
  const value = new OpeningInquiryOwner("controlled", "/owned", () => {});
  owners.push(value);
  return value;
}

// Only a count of logical references held by this production object. Neither
// collection nor retained bytes/RSS can be inferred from this inspection.
function logicalInterests(value: OpeningInquiryOwner): number {
  return (value as unknown as { interested: unknown[] }).interested.length;
}

afterEach(() => {
  owners.splice(0).forEach((value) => value.retire());
  h.invoke.mockReset();
  h.open.mockReset();
  vi.restoreAllMocks();
});

it.each(["finish", "retire"] as const)(
  "%s refuses new signal listeners and callers after the owner ended",
  async (end) => {
    h.invoke.mockResolvedValue({ status: "submitted" });
    const value = owner();
    const initial = new AbortController();
    const removed = vi.spyOn(initial.signal, "removeEventListener");
    value.addInterest(() => true, initial.signal);
    value.receive(question);
    const details = { mode: "future", publicMarker: "owned-details" };
    value.receive({ kind: "elicitationUnavailable", params: details });
    if (end === "finish") value.finish(true);
    else value.retire();
    const ended = value.snapshot();
    expect(ended).toMatchObject({ ended: true, requests: [], details });
    expect(ended.notice).toBe(
      end === "finish" ? INQUIRY.openEnded : INQUIRY.closed,
    );
    expect(removed).toHaveBeenCalledTimes(1);

    const late = new AbortController();
    const registered = vi.spyOn(late.signal, "addEventListener");
    const current = vi.fn(() => true);
    value.addInterest(current, late.signal);
    const noSignalCurrent = vi.fn(() => true);
    value.addInterest(noSignalCurrent);
    late.abort();
    await Promise.resolve();
    await value.reply(question.requestId, "accept");

    expect(value.snapshot()).toBe(ended);
    expect(current).not.toHaveBeenCalled();
    expect(noSignalCurrent).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.invoke.mock.calls.map((call) => call[1].action)).toEqual(
      end === "retire" ? ["cancel"] : [],
    );
    expect(registered).not.toHaveBeenCalled();
    expect(logicalInterests(value)).toBe(0);
  },
);

it.each([8, 64])(
  "releases %s coalesced caller references on either terminal path",
  (count) => {
    for (const end of ["finish", "retire"] as const) {
      const value = owner();
      const callers = Array.from({ length: count }, (_, index) => ({
        key: `owned-caller-${index}`,
        // Stand-in for caller-owned state, never a real draft or Agent body.
        publicText: "owned-public".repeat(32),
      }));
      for (const caller of callers)
        value.addInterest(() => caller.publicText.length > 0);
      expect(logicalInterests(value)).toBe(count);
      if (end === "finish") value.finish();
      else value.retire();
      console.info(
        "OPENING_INTEREST_COUNT",
        JSON.stringify({
          end,
          callers: count,
          afterTerminal: logicalInterests(value),
          logicalReferencesOnly: true,
        }),
      );
      expect(value.snapshot().ended).toBe(true);
      expect(logicalInterests(value)).toBe(0);
    }
  },
);

it("keeps a surviving coalesced caller usable before terminal cleanup", async () => {
  h.invoke.mockResolvedValue({ status: "submitted" });
  const value = owner();
  const one = new AbortController();
  const two = new AbortController();
  const first = vi.fn(() => true);
  const second = vi.fn(() => true);
  value.addInterest(first, one.signal);
  value.addInterest(second, two.signal);
  value.receive(question);
  one.abort();
  await Promise.resolve();
  expect(value.snapshot()).toMatchObject({
    ended: false,
    requests: [expect.objectContaining({ requestId: question.requestId })],
  });
  expect(h.invoke).not.toHaveBeenCalled();
  await value.reply(question.requestId, "decline");
  expect(h.invoke.mock.calls.map((call) => call[1].action)).toEqual([
    "decline",
  ]);
  expect(h.open).not.toHaveBeenCalled();
  expect(value.snapshot().requests).toEqual([]);
  expect(second).toHaveBeenCalled();
  value.finish();
  expect(logicalInterests(value)).toBe(0);
});
