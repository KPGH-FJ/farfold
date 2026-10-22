import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDeliveryObserver } from "./session_delivery_observer";
import { openDeliveryConsumer } from "./session_open_delivery";
import { freshThreadState } from "./session_projection";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const id = "00000000000040008000000000000001";
function envelope(
  event: unknown,
  sequence = "1",
  sampleId: string | null = "1",
) {
  return {
    farfoldDelivery: {
      openToken: "open",
      observerId: id,
      sequence,
      ...(sampleId ? { sampleId } : {}),
    },
    event,
  };
}
const outcomes = () =>
  invoke.mock.calls.map(([, args]) => args.receipt.outcome);
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(true);
});

describe("content-free delivery consumption samples", () => {
  it("receipts only after the synchronous reducer returns, never on arrival", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    observer.receive(envelope({ update: "sample" }), () => {
      expect(invoke).not.toHaveBeenCalled();
      return "consumed";
    });
    expect(outcomes()).toEqual(["consumed"]);
  });
  it("buffers without acknowledging, then acknowledges its actual FIFO consumption", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    observer.receive({ earlier: true }, () => "buffered");
    observer.receive(envelope({ sample: true }), () => "buffered");
    for (let i = 2; i < 100; i++)
      observer.receive(envelope({}, String(i), null), () => "buffered");
    expect(invoke).not.toHaveBeenCalled();
    observer.consumeBuffered(() => {});
    expect(invoke).not.toHaveBeenCalled();
    observer.consumeBuffered(() => expect(invoke).not.toHaveBeenCalled());
    expect(outcomes()).toEqual(["consumed"]);
  });
  it("reports cache replacement and throwing consumption separately", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    observer.receive(envelope({}), () => "buffered");
    observer.discardBuffered();
    observer.receive(envelope({}, "2", "2"), () => "buffered");
    expect(() =>
      observer.consumeBuffered(() => {
        throw new Error("reducer");
      }),
    ).toThrow("reducer");
    expect(outcomes()).toEqual(["discarded", "error"]);
  });
  it("records synchronous exceptions without swallowing them", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    expect(() =>
      observer.receive(envelope({}), () => {
        throw new Error("projector");
      }),
    ).toThrow("projector");
    expect(outcomes()).toEqual(["error"]);
  });
  it("waits for queued control consumption and does not let late completion revive a retired owner", async () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    let resolve!: (value: "consumed") => void;
    observer.receive(
      envelope({}),
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    expect(invoke).not.toHaveBeenCalled();
    observer.dispose();
    resolve("consumed");
    await Promise.resolve();
    expect(outcomes()).toEqual(["discarded"]);
  });
  it("does not retry or claim success after an undelivered receipt", async () => {
    invoke.mockRejectedValue(new Error("transport unavailable"));
    const observer = new SessionDeliveryObserver("agent", "open");
    observer.receive(envelope({}), () => "consumed");
    await Promise.resolve();
    observer.dispose();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("does not interrupt the actual channel when a disappearing IPC bridge throws synchronously", () => {
    invoke.mockImplementation(() => {
      throw new Error("bridge gone");
    });
    const observer = new SessionDeliveryObserver("agent", "open");
    const consume = vi.fn(() => "consumed" as const);
    expect(() => observer.receive(envelope({}), consume)).not.toThrow();
    expect(consume).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("never treats Agent inner JSON as a control envelope", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    const forged = envelope({ secret: "not a receipt" }, "999", "999");
    observer.receive(envelope(forged), (event) => {
      expect(event).toBe(forged);
      return "consumed";
    });
    expect(invoke.mock.calls[0][1].receipt).toEqual({
      observerId: id,
      sequence: "1",
      sampleId: "1",
      outcome: "consumed",
    });
  });
  it.each([false, true])(
    "preserves both unknown bodies when real send order differs from serialization order (buffered=%s)",
    (buffered) => {
      const observer = new SessionDeliveryObserver("agent", "open");
      const actual: unknown[] = [];
      const consume = (event: unknown) => {
        actual.push(event);
        return buffered ? ("buffered" as const) : ("consumed" as const);
      };
      const second = { unknown: 2 };
      const first = { unknown: 1, farfoldDelivery: { sampleId: "forged" } };
      observer.receive(envelope(second, "2", null), consume);
      observer.receive(envelope(first, "1", "1"), consume);
      expect(actual).toEqual([second, first]);
      if (buffered) {
        expect(invoke).not.toHaveBeenCalled();
        observer.consumeBuffered(() => {});
        expect(invoke).not.toHaveBeenCalled();
        observer.consumeBuffered(() => {});
      }
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0][1].receipt).toMatchObject({
        sequence: "1",
        sampleId: "1",
        outcome: "consumed",
      });
    },
  );
  it("does not let mismatched observation metadata discard an actual channel payload", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    const consume = vi.fn(() => "consumed" as const);
    observer.receive(envelope({}), consume);
    observer.receive(envelope({}), consume);
    observer.receive(
      {
        ...envelope({}, "2", "2"),
        farfoldDelivery: {
          ...envelope({}).farfoldDelivery,
          openToken: "old",
          sequence: "2",
        },
      },
      consume,
    );
    observer.receive(
      {
        ...envelope({}, "2", "2"),
        farfoldDelivery: {
          ...envelope({}).farfoldDelivery,
          observerId: "00000000000040008000000000000002",
          sequence: "2",
        },
      },
      consume,
    );
    expect(consume).toHaveBeenCalledTimes(4);
    expect(outcomes()).toEqual(["consumed"]);
  });
  it("a replaced live open channel does not consume controls or report success", () => {
    const observer = new SessionDeliveryObserver("agent", "open");
    const state = freshThreadState("key", "agent", "/work", "native");
    const marker = vi.fn(() => true);
    const apply = vi.fn();
    const consume = openDeliveryConsumer(observer, {
      key: () => "key",
      owns: () => false,
      thread: () => state,
      inquiry: () => false,
      recheck: vi.fn(),
      marker,
      historyFailed: () => false,
      failedLive: () => false,
      applyFailed: vi.fn(),
      apply,
      receiving: () => true,
      buffer: vi.fn(),
    });
    consume(envelope({ kind: "session_history_complete", openToken: "open" }));
    expect(marker).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["discarded"]);
  });
});
