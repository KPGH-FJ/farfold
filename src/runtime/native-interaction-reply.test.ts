import { describe, expect, it, vi } from "vitest";
import { NativeInteractionReply } from "./native-interaction-reply";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("native interaction replies", () => {
  it("keeps the request visible until accepted and sends only one reply", async () => {
    const reply = new NativeInteractionReply();
    reply.reconcile("session:1:request");
    const response = deferred();
    const send = vi.fn(() => response.promise);
    const accepted = vi.fn();
    const failed = vi.fn();
    const first = reply.reply(send, accepted, failed, vi.fn());
    await reply.reply(send, accepted, failed, vi.fn());
    expect(send).toHaveBeenCalledTimes(1);
    expect(reply.busy).toBe(true);
    expect(accepted).not.toHaveBeenCalled();
    response.resolve();
    await first;
    expect(accepted).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    await reply.reply(send, accepted, failed, vi.fn());
    expect(send).toHaveBeenCalledTimes(1);
    reply.reconcile(null);
    expect(reply.busy).toBe(false);
  });

  it("preserves a rejected request for an explicit retry", async () => {
    const reply = new NativeInteractionReply();
    reply.reconcile("session:1:request");
    const accepted = vi.fn();
    const failed = vi.fn();
    await reply.reply(
      () => Promise.reject(new Error("native refusal")),
      accepted,
      failed,
      vi.fn(),
    );
    expect(accepted).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith("Error: native refusal");
    expect(reply.error).toBe("Error: native refusal");
    expect(reply.busy).toBe(false);
    await reply.reply(() => Promise.resolve(), accepted, failed, vi.fn());
    expect(accepted).toHaveBeenCalledOnce();
    expect(reply.error).toBeNull();
  });

  it.each(["accepted", "failed"])(
    "ignores an old %s reply after expiry or a generation change",
    async (result) => {
      const reply = new NativeInteractionReply();
      reply.reconcile("session:1:request");
      const old = deferred();
      const accepted = vi.fn();
      const failed = vi.fn();
      const first = reply.reply(() => old.promise, accepted, failed, vi.fn());
      reply.reconcile(null);
      reply.reconcile("session:2:request");
      const current = deferred();
      const second = reply.reply(
        () => current.promise,
        vi.fn(),
        vi.fn(),
        vi.fn(),
      );
      if (result === "accepted") old.resolve();
      else old.reject(new Error("old process"));
      await first;
      expect(accepted).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect(reply.error).toBeNull();
      expect(reply.busy).toBe(true);
      current.resolve();
      await second;
    },
  );
});
