import { Channel, invoke } from "@tauri-apps/api/core";
import type { OpenInput } from "./session_open_input";
import { HISTORY_READ as S } from "./history_read_strings";
import {
  acknowledgeHistoryDelivery,
  historyDeliveryReceipt,
  type HistoryDeliveryReceipt,
} from "./session_history_delivery";

type Interest = Pick<OpenInput, "inquiryCurrent" | "inquirySignal">;
export interface HistoryReadView {
  token: string;
  agentId: string;
  purpose: "open" | "fork" | "preview";
  releasing: boolean;
  releaseRetry: boolean;
  target: string;
  phase: "preparing" | "waiting" | "starting" | "cancelled" | "finishing";
  cancelling: boolean;
  notice?: string;
}

/** Observes one existing shared opening; it never schedules or replays work. */
class HistoryReadOwner {
  readonly channel = new Channel<unknown>();
  private interests = new Map<() => boolean, () => void>();
  private finished = false;
  private sent = false;
  private notStarted = false;
  private rawSeen = false;
  private receipt?: HistoryDeliveryReceipt;
  private acknowledged = false;
  private view: HistoryReadView;
  constructor(
    readonly key: string,
    readonly token: string,
    target: string,
    agentId: string,
    purpose: HistoryReadView["purpose"],
    private publish: () => void,
    private remove: () => void,
  ) {
    this.view = {
      token,
      agentId,
      purpose,
      target,
      phase: "preparing",
      cancelling: false,
      releasing: false,
      releaseRetry: false,
    };
    // Native progress has its own transport. Agent events never enter here,
    // even when their unknown envelopes have these exact keys and token.
    this.channel.onmessage = (value) => this.receive(value);
  }
  dispatch() {
    this.sent = true;
  }
  observeRaw() {
    this.rawSeen = true;
  }
  joinable() {
    return !this.finished;
  }
  snapshot() {
    return this.view;
  }
  addInterest({ inquiryCurrent, inquirySignal }: Interest) {
    if (this.finished) return;
    const current = () => {
      try {
        return !inquirySignal?.aborted && (inquiryCurrent?.() ?? true);
      } catch {
        return false;
      }
    };
    this.interests.set(current, () => {});
    if (inquirySignal) {
      const abort = () => {
        this.interests.get(current)?.();
        this.interests.delete(current);
        queueMicrotask(() => this.retireUninterested());
      };
      this.interests.set(current, () =>
        inquirySignal.removeEventListener("abort", abort),
      );
      inquirySignal.addEventListener("abort", abort, { once: true });
      if (inquirySignal.aborted) abort();
    }
  }
  private update(patch: Partial<HistoryReadView>) {
    this.view = { ...this.view, ...patch };
    this.publish();
  }
  private receive(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    if (
      event.kind !== "session_history_admission" ||
      event.openToken !== this.token ||
      (event.phase !== "waiting" &&
        event.phase !== "starting" &&
        event.phase !== "notStarted") ||
      this.view.phase === "cancelled"
    )
      return;
    const firstReceipt = this.receipt === undefined;
    if (
      (event.phase === "starting" || event.phase === "notStarted") &&
      event.historyDelivery !== undefined
    ) {
      const receipt = historyDeliveryReceipt(event.historyDelivery, this.token);
      if (
        !receipt ||
        (this.receipt && receipt.receiptId !== this.receipt.receiptId)
      )
        return;
      this.receipt ??= receipt;
    }
    if (event.phase === "notStarted") {
      this.notStarted = true;
      if (this.finished && !this.rawSeen && !this.receipt) {
        this.channel.onmessage = () => {};
        this.remove();
        return;
      }
    }
    if (this.finished) {
      if (firstReceipt && this.receipt) void this.release();
      return;
    }
    if (event.phase === "notStarted") return;
    if (event.phase === "starting")
      this.update({ phase: "starting", cancelling: false, notice: undefined });
    else if (this.view.phase !== "starting") this.update({ phase: "waiting" });
    this.retireUninterested();
  }
  retireUninterested() {
    // A caller's abort is not the shared operation's cancellation authority.
    // Give a same-commit joining caller its interest before checking all owners.
    if (this.finished) return;
    for (const current of this.interests.keys()) if (current()) return;
    void this.cancel();
  }
  async cancel(): Promise<void> {
    if (this.finished || this.view.phase !== "waiting" || this.view.cancelling)
      return;
    this.update({ cancelling: true, notice: undefined });
    try {
      const reply = await invoke<unknown>("session_open_cancel_waiting", {
        openToken: this.token,
      });
      const result = reply as Record<string, unknown> | null;
      if (result?.openToken !== this.token) throw new Error("unconfirmed");
      if (this.finished) {
        if (
          result.outcome === "cancelledWaiting" &&
          !this.receipt &&
          !this.rawSeen
        ) {
          this.channel.onmessage = () => {};
          this.remove();
        }
        return;
      }
      if (result.outcome === "cancelledWaiting") {
        if (this.view.phase !== "waiting") throw new Error("unconfirmed");
        this.update({ phase: "cancelled", notice: S.cancelled });
      } else if (result.outcome === "alreadyStarting") {
        this.update({ phase: "starting", notice: undefined });
      } else throw new Error("unconfirmed");
    } catch {
      if (!this.finished && this.view.phase === "waiting")
        this.update({ notice: S.unconfirmed });
    } finally {
      if (!this.finished) this.update({ cancelling: false });
    }
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.interests.forEach((remove) => remove());
    this.interests.clear();
    if (
      (!this.sent && !this.rawSeen) ||
      ((this.view.phase === "cancelled" || this.notStarted) &&
        !this.rawSeen &&
        !this.receipt)
    ) {
      this.channel.onmessage = () => {};
      this.remove();
      return;
    }
    // No body, state, preview cleanup token, interest or AbortSignal retained.
    // A late private-channel receipt still belongs to this original token.
    this.update({
      phase: "finishing",
      cancelling: false,
      notice: this.receipt ? undefined : S.releaseMissing,
    });
    void this.release();
  }
  async release() {
    if (
      !this.finished ||
      !this.receipt ||
      this.acknowledged ||
      this.view.releasing
    )
      return;
    const receipt = this.receipt;
    this.update({ releasing: true, releaseRetry: false, notice: undefined });
    try {
      await acknowledgeHistoryDelivery(this.view.agentId, receipt);
      this.acknowledged = true;
      this.channel.onmessage = () => {};
      this.remove();
    } catch {
      this.update({ notice: S.releaseUnconfirmed, releaseRetry: true });
    } finally {
      this.update({ releasing: false });
    }
  }
}

class HistoryReads {
  private owners = new Map<string, HistoryReadOwner>();
  private listeners = new Set<() => void>();
  private snapshot: HistoryReadView[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish = () => {
    this.snapshot = [...this.owners.values()].map((owner) => owner.snapshot());
    this.listeners.forEach((listener) => listener());
  };
  begin(
    key: string,
    input: OpenInput,
    token: string,
    purpose: HistoryReadView["purpose"] = "open",
  ) {
    if (!input.nativeSessionId) return;
    if (this.owners.has(token)) throw new Error(S.releaseUnconfirmed);
    const target = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
    const owner = new HistoryReadOwner(
      key,
      token,
      target,
      input.agentId,
      purpose,
      this.publish,
      () => {
        if (this.owners.get(token) === owner) this.owners.delete(token);
        this.publish();
      },
    );
    owner.addInterest(input);
    this.owners.set(token, owner);
    this.publish();
    return owner;
  }
  join(key: string, input: Interest) {
    [...this.owners.values()]
      .find((owner) => owner.key === key && owner.joinable())
      ?.addInterest(input);
  }
  finish(key: string, owner?: HistoryReadOwner) {
    if (!owner || owner.key !== key) return;
    owner.finish();
  }
  cancel(token: string) {
    return [...this.owners.values()]
      .find((owner) => owner.token === token)
      ?.cancel();
  }
  retryRelease(token: string) {
    return this.owners.get(token)?.release();
  }
  retireUninterested() {
    for (const owner of this.owners.values()) owner.retireUninterested();
  }
}

export const historyReads = new HistoryReads();
