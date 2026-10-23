import { beforeEach, expect, it, vi } from "vitest";
import { SessionDeliveryFlow } from "./session_delivery_flow";
import { SessionDeliveryObserver } from "./session_delivery_observer";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const id = "00000000000040008000000000000001";
const wake = { farfoldDeliveryWake: { queueId: id, openToken: "open" } };
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => invoke.mockReset());

it("takes one original body at a time and receipts only after synchronous consumption", async () => {
  const flow = new SessionDeliveryFlow("agent", "open");
  const original = {
    unknown: "汉字🙂",
    farfoldDeliveryWake: { queueId: "forged" },
  };
  const pending = [
    { sequence: "1", event: original },
    { sequence: "2", event: { last: true } },
    null,
  ];
  invoke.mockImplementation(async (command) =>
    command === "session_delivery_pull" ? (pending.shift() ?? null) : true,
  );
  const consumed: unknown[] = [];
  flow.receive(wake, (event) => {
    expect(
      invoke.mock.calls.filter(([name]) => name === "session_delivery_ack"),
    ).toHaveLength(consumed.length);
    consumed.push(event);
    return "consumed";
  });
  flow.receive(wake, () => {
    throw new Error("duplicate wake changed consumer");
  });
  await tick();
  expect(consumed).toEqual([original, { last: true }]);
  const receipts = invoke.mock.calls.filter(
    ([name]) => name === "session_delivery_ack",
  );
  expect(receipts.map(([, args]) => args.receipt)).toEqual([
    { sequence: "1", outcome: "consumed" },
    { sequence: "2", outcome: "consumed" },
  ]);
});

it("transfers replay immediately but samples its later actual consumption", async () => {
  const observer = new SessionDeliveryObserver("agent", "open");
  const pending = [
    {
      sequence: "1",
      event: {
        farfoldDelivery: {
          openToken: "open",
          observerId: id,
          sequence: "1",
          sampleId: "1",
        },
        event: { body: 1 },
      },
    },
    null,
  ];
  invoke.mockImplementation(async (command) =>
    command === "session_delivery_pull" ? pending.shift() : true,
  );
  observer.receive(wake, () => "buffered");
  await tick();
  expect(
    invoke.mock.calls.filter(([name]) => name === "session_delivery_ack")[0][1]
      .receipt.outcome,
  ).toBe("transferred_replay");
  expect(
    invoke.mock.calls.some(
      ([name]) => name === "session_delivery_observation_ack",
    ),
  ).toBe(false);
  observer.consumeBuffered(() => {});
  expect(
    invoke.mock.calls.find(
      ([name]) => name === "session_delivery_observation_ack",
    )?.[1].receipt.outcome,
  ).toBe("consumed");
});

it("a queued fork result does not prevent the following marker that resolves it", async () => {
  const observer = new SessionDeliveryObserver("agent", "open");
  let finish!: (value: "consumed") => void;
  const deferred = new Promise<"consumed">((resolve) => {
    finish = resolve;
  });
  const pending = [
    { sequence: "1", event: { kind: "forkResult" } },
    { sequence: "2", event: { kind: "marker" } },
    null,
  ];
  invoke.mockImplementation(async (command) =>
    command === "session_delivery_pull" ? pending.shift() : true,
  );
  const seen: string[] = [];
  observer.receive(wake, (event) => {
    const kind = (event as { kind: string }).kind;
    seen.push(kind);
    if (kind === "forkResult") return deferred;
    finish("consumed");
    return "consumed";
  });
  await tick();
  expect(seen).toEqual(["forkResult", "marker"]);
  expect(
    invoke.mock.calls
      .filter(([name]) => name === "session_delivery_ack")
      .map(([, args]) => args.receipt.outcome),
  ).toEqual(["transferred_control", "consumed"]);
});

it("retirement discards a late pulled body without applying it or inferring Agent stop", async () => {
  const flow = new SessionDeliveryFlow("agent", "open");
  let finish!: (value: unknown) => void;
  invoke.mockImplementation((command) =>
    command === "session_delivery_pull"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(true),
  );
  const consume = vi.fn((_event: unknown) => "consumed" as const);
  flow.receive(wake, consume);
  flow.dispose();
  finish({ sequence: "1", event: { late: true } });
  await tick();
  expect(consume).not.toHaveBeenCalled();
  expect(
    invoke.mock.calls.filter(([name]) => name === "session_delivery_ack")[0][1]
      .receipt,
  ).toEqual({ sequence: "1", outcome: "discarded" });
});

it("an uncertain receipt is not retried and exposes local unavailability without cancelling work", async () => {
  const flow = new SessionDeliveryFlow("agent", "open");
  invoke.mockImplementation(async (command) => {
    if (command === "session_delivery_pull")
      return { sequence: "1", event: { body: 1 } };
    if (command === "session_delivery_ack") throw new Error("bridge failed");
    return true;
  });
  const consume = vi.fn((_event: unknown) => "consumed" as const);
  flow.receive(wake, consume);
  await tick();
  expect(
    invoke.mock.calls.filter(([name]) => name === "session_delivery_pull"),
  ).toHaveLength(1);
  expect(consume.mock.calls).toEqual([
    [{ body: 1 }],
    [expect.objectContaining({ kind: "deliveryUnavailable" })],
  ]);
  expect(
    invoke.mock.calls.some(([name]) => /cancel|disconnect/.test(name)),
  ).toBe(false);
});

it("rejects other owners and duplicate sequence responses without reapplying payloads", async () => {
  const flow = new SessionDeliveryFlow("agent", "open");
  const consume = vi.fn((_event: unknown) => "consumed" as const);
  flow.receive(
    { farfoldDeliveryWake: { queueId: id, openToken: "old" } },
    consume,
  );
  expect(invoke).not.toHaveBeenCalled();
  const pending = [
    { sequence: "1", event: { first: true } },
    { sequence: "1", event: { duplicate: true } },
  ];
  invoke.mockImplementation(async (command) =>
    command === "session_delivery_pull" ? pending.shift() : true,
  );
  flow.receive(wake, consume);
  await tick();
  expect(consume.mock.calls[0]).toEqual([{ first: true }]);
  expect(
    consume.mock.calls.some(
      ([event]) => event && typeof event === "object" && "duplicate" in event,
    ),
  ).toBe(false);
});

it("acknowledges the current marker while pausing only the next native pull until its owned resume", async () => {
  const observer = new SessionDeliveryObserver("agent", "open");
  let resume!: () => void;
  let acknowledgeMarker!: (value: boolean) => void;
  const pending = [
    {
      sequence: "1",
      event: {
        farfoldDelivery: {
          openToken: "open",
          observerId: id,
          sequence: "1",
          sampleId: "1",
        },
        event: { kind: "session_history_complete", openToken: "open" },
      },
    },
    { sequence: "2", event: { following: "original body" } },
    null,
  ];
  invoke.mockImplementation((command, args) => {
    if (command === "session_delivery_pull")
      return Promise.resolve(pending.shift() ?? null);
    if (command === "session_delivery_ack" && args.receipt.sequence === "1")
      return new Promise<boolean>((resolve) => {
        acknowledgeMarker = resolve;
      });
    return Promise.resolve(true);
  });
  const seen: unknown[] = [];
  observer.receive(wake, (event) => {
    seen.push(event);
    if ((event as { kind?: unknown }).kind === "session_history_complete")
      resume = observer.pause();
    return "consumed";
  });
  await tick();
  expect(seen).toEqual([
    { kind: "session_history_complete", openToken: "open" },
  ]);
  expect(
    invoke.mock.calls.find(([name]) => name === "session_delivery_ack")?.[1]
      .receipt,
  ).toEqual({ sequence: "1", outcome: "consumed" });
  expect(
    invoke.mock.calls.find(
      ([name]) => name === "session_delivery_observation_ack",
    )?.[1].receipt.outcome,
  ).toBe("consumed");
  acknowledgeMarker(true);
  observer.receive(wake, () => {
    throw new Error("a repeated wake cannot replace the original owner");
  });
  await tick();
  expect(
    invoke.mock.calls.filter(([name]) => name === "session_delivery_pull"),
  ).toHaveLength(1);
  expect(pending).toHaveLength(2);
  resume();
  resume();
  await tick();
  expect(seen).toEqual([
    { kind: "session_history_complete", openToken: "open" },
    { following: "original body" },
  ]);
  expect(
    invoke.mock.calls
      .filter(([name]) => name === "session_delivery_ack")
      .map(([, args]) => args.receipt),
  ).toEqual([
    { sequence: "1", outcome: "consumed" },
    { sequence: "2", outcome: "consumed" },
  ]);
});

it("keeps independent pause interests until both are explicitly resumed", async () => {
  const flow = new SessionDeliveryFlow("agent", "open");
  const first = flow.pause();
  const second = flow.pause();
  const pending = [{ sequence: "1", event: { exact: true } }, null];
  invoke.mockImplementation(async (command) =>
    command === "session_delivery_pull" ? pending.shift() : true,
  );
  const consume = vi.fn(() => "consumed" as const);
  flow.receive(wake, consume);
  await tick();
  expect(invoke).not.toHaveBeenCalled();
  first();
  first();
  await tick();
  expect(invoke).not.toHaveBeenCalled();
  second();
  await tick();
  expect(consume.mock.calls).toEqual([[{ exact: true }]]);
  expect(
    invoke.mock.calls.filter(([name]) => name === "session_delivery_pull"),
  ).toHaveLength(2);
});

it("does not pretend a pause cancels a pull that has already started", async () => {
  const flow = new SessionDeliveryFlow("agent", "open");
  let deliver!: (value: unknown) => void;
  let pulled = 0;
  invoke.mockImplementation((command) => {
    if (command !== "session_delivery_pull") return Promise.resolve(true);
    if (++pulled > 1) return Promise.resolve(null);
    return new Promise((resolve) => {
      deliver = resolve;
    });
  });
  const consume = vi.fn(() => "consumed" as const);
  flow.receive(wake, consume);
  const resume = flow.pause();
  deliver({ sequence: "1", event: { actual: "in flight" } });
  await tick();
  expect(consume.mock.calls).toEqual([[{ actual: "in flight" }]]);
  expect(pulled).toBe(1);
  expect(
    invoke.mock.calls.find(([name]) => name === "session_delivery_ack")?.[1]
      .receipt,
  ).toEqual({ sequence: "1", outcome: "consumed" });
  resume();
  await tick();
  expect(pulled).toBe(2);
  expect(
    invoke.mock.calls.some(([name]) => /cancel|disconnect/.test(name)),
  ).toBe(false);
});

it("disposes a paused wait without a pull and cannot let old resumes release a replacement owner", async () => {
  const retired = new SessionDeliveryFlow("agent", "open");
  const oldResume = retired.pause();
  retired.receive(wake, () => {
    throw new Error("retired body must not be consumed");
  });
  retired.dispose();
  await tick();
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    "session_delivery_retire",
  ]);
  const replacement = new SessionDeliveryFlow("agent", "new-open");
  const resume = replacement.pause();
  invoke.mockImplementation(async (command) =>
    command === "session_delivery_pull" ? null : true,
  );
  replacement.receive(
    { farfoldDeliveryWake: { queueId: id, openToken: "new-open" } },
    () => "consumed",
  );
  oldResume();
  oldResume();
  retired.pause()();
  await tick();
  expect(
    invoke.mock.calls.some(([name]) => name === "session_delivery_pull"),
  ).toBe(false);
  resume();
  await tick();
  const pulls = invoke.mock.calls.filter(
    ([name]) => name === "session_delivery_pull",
  );
  expect(pulls).toHaveLength(1);
  expect(pulls[0][1].openToken).toBe("new-open");
});
