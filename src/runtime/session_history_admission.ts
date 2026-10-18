import { Channel, invoke } from "@tauri-apps/api/core";
import type { OpenInput } from "./session_open_input";
import { HISTORY_READ as S } from "./history_read_strings";

type Interest = Pick<OpenInput, "inquiryCurrent" | "inquirySignal">;
export interface HistoryReadView {
  token: string;
  target: string;
  phase: "preparing" | "waiting" | "starting" | "cancelled";
  cancelling: boolean;
  notice?: string;
}

/** Observes one existing shared opening; it never schedules or replays work. */
class HistoryReadOwner {
  readonly channel = new Channel<unknown>();
  private interests = new Map<() => boolean, () => void>();
  private finished = false;
  private view: HistoryReadView;
  constructor(
    readonly token: string,
    target: string,
    private publish: () => void,
  ) {
    this.view = { token, target, phase: "preparing", cancelling: false };
    // Native progress has its own transport. Agent events never enter here,
    // even when their unknown envelopes have these exact keys and token.
    this.channel.onmessage = (value) => this.receive(value);
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
    if (this.finished) return;
    this.view = { ...this.view, ...patch };
    this.publish();
  }
  private receive(value: unknown) {
    if (this.finished || !value || typeof value !== "object") return;
    const event = value as Record<string, unknown>;
    if (
      event.kind !== "session_history_admission" ||
      event.openToken !== this.token ||
      (event.phase !== "waiting" && event.phase !== "starting") ||
      this.view.phase === "cancelled"
    )
      return;
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
      if (this.finished) return;
      const result = reply as Record<string, unknown> | null;
      if (result?.openToken !== this.token) throw new Error("unconfirmed");
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
    this.finished = true;
    this.channel.onmessage = () => {};
    this.interests.forEach((remove) => remove());
    this.interests.clear();
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
  begin(key: string, input: OpenInput, token: string) {
    if (!input.nativeSessionId) return;
    const target = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
    const owner = new HistoryReadOwner(token, target, this.publish);
    owner.addInterest(input);
    this.owners.set(key, owner);
    this.publish();
    return owner;
  }
  join(key: string, input: Interest) {
    this.owners.get(key)?.addInterest(input);
  }
  finish(key: string, owner?: HistoryReadOwner) {
    if (!owner) return;
    owner.finish();
    if (this.owners.get(key) === owner) {
      this.owners.delete(key);
      this.publish();
    }
  }
  cancel(token: string) {
    return [...this.owners.values()]
      .find((owner) => owner.token === token)
      ?.cancel();
  }
  retireUninterested() {
    for (const owner of this.owners.values()) owner.retireUninterested();
  }
}

export const historyReads = new HistoryReads();
