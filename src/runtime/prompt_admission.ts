import { Channel, invoke } from "@tauri-apps/api/core";
import type { ThreadState } from "./session_types";
import { pauseQueue, removeQueued } from "./queue";
import { PROMPT_ADMISSION as S } from "./prompt_admission_strings";

export interface PromptAdmissionView {
  phase: "waiting" | "preparing" | "offered";
  cancelling: boolean;
  notice?: string;
}
type CancelReply = { receiptId: number; outcome: string };
type CancelDispatch =
  "pendingReceipt" | "acknowledged" | "unconfirmed" | "inactive";

function currentSubmission(thread: ThreadState) {
  const submission = thread.promptSubmission;
  return submission && submission.connectionId === thread.connectionId
    ? submission
    : undefined;
}

/** Settle queue ownership before replacing or losing the exact connection. */
export function retirePromptSubmission(thread: ThreadState): void {
  const submission = currentSubmission(thread);
  if (!submission) return;
  if (submission.deliveryConfirmed) {
    // A replacement inherits the live queue, not the saved projection.
    removeQueued(thread, submission.blocks);
    thread.promptSubmission = undefined;
    thread.identity = "established";
  } else if (submission.dispatched) {
    thread.connectionOutcomeUnknown = true;
    if (thread.queued.includes(submission.blocks)) {
      thread.uncertainPrompt = submission.blocks;
      thread.identity = "established";
    }
  }
}

/** Keep the live queue intact until IPC settles, while excluding a confirmed
 * delivery from recovery. An unknown outcome still quarantines its exact input. */
export function persistedQueue(thread: ThreadState) {
  const submission = currentSubmission(thread);
  const deliveredIndex = submission?.deliveryConfirmed
    ? thread.queued.indexOf(submission.blocks)
    : -1;
  const blocks =
    deliveredIndex < 0
      ? thread.queued
      : [
          ...thread.queued.slice(0, deliveredIndex),
          ...thread.queued.slice(deliveredIndex + 1),
        ];
  const uncertain =
    thread.uncertainPrompt ??
    (!thread.connectionLost && !submission?.deliveryConfirmed
      ? submission?.blocks
      : undefined);
  const index = uncertain ? blocks.indexOf(uncertain) : -1;
  return { blocks, uncertainIndex: index < 0 ? null : index };
}

/** Exactly one current local send. No message history or global request map. */
export class PromptRequestOwner {
  readonly token = crypto.randomUUID();
  readonly channel = new Channel<unknown>();
  private receipt: number | null = null;
  private ended = false;
  private endingObserved = false;
  private offered = false;
  private cancelledBeforeOffer = false;
  private cancelRequested = false;
  private earlyCancel = false;
  private unconfirmedWaitingStop = false;
  private cancelling: Promise<CancelDispatch> | null = null;
  constructor(
    private thread: ThreadState,
    private current: () => boolean,
    private emit: () => void,
    private onOffer: () => void,
    private onEnd: () => void,
    private onEarlyStopAcknowledged: () => void,
    readonly confirmDelivery: () => void,
  ) {
    thread.promptAdmission = { phase: "preparing", cancelling: false };
    this.channel.onmessage = (value) => this.receive(value);
  }
  private receive(value: unknown): void {
    if (this.ended || !this.current() || !value || typeof value !== "object")
      return;
    const p = value as Record<string, unknown>;
    if (
      Object.keys(p).length !== 2 ||
      !Number.isSafeInteger(p.receiptId) ||
      Number(p.receiptId) <= 0 ||
      !["waiting", "preparing", "offered"].includes(String(p.phase))
    )
      return;
    if (this.receipt !== null && this.receipt !== p.receiptId) return;
    this.receipt = Number(p.receiptId);
    if (p.phase === "offered" && this.cancelledBeforeOffer) {
      if (this.thread.promptAdmission)
        this.thread.promptAdmission.notice = S.unconfirmed;
      this.emit();
      return;
    }
    if (p.phase === "offered") this.accepted();
    else if (!this.offered && this.thread.promptAdmission) {
      this.thread.promptAdmission.phase = p.phase as "waiting" | "preparing";
      this.emit();
    }
    if (this.cancelRequested && !this.cancelling) void this.cancel(false);
  }
  accepted(): void {
    if (this.ended || this.endingObserved || !this.current()) return;
    this.offered = true;
    this.thread.promptAdmission = { phase: "offered", cancelling: false };
    this.thread.running = true;
    if (this.unconfirmedWaitingStop) this.preserveUnconfirmedWaitingStop();
    this.onOffer();
    this.emit();
  }
  private preserveUnconfirmedWaitingStop(): void {
    // A waiting prompt can still be definitively rejected. Only promote the
    // lost stop reply to a running prompt's unknown stop once it was offered.
    this.unconfirmedWaitingStop = !this.offered;
    if (this.offered) {
      this.thread.stopUnconfirmed = true;
      pauseQueue(this.thread, "uncertain");
    }
  }
  ending(receipt: unknown): boolean {
    if (
      this.ended ||
      this.cancelledBeforeOffer ||
      !Number.isSafeInteger(receipt) ||
      Number(receipt) <= 0 ||
      (this.receipt !== null && this.receipt !== receipt)
    )
      return false;
    this.receipt = Number(receipt);
    this.accepted();
    this.endingObserved = true;
    // An ending can be the first receipt, before any progress message.
    if (this.cancelRequested && !this.cancelling) void this.cancel(false);
    return true;
  }
  isOffered(): boolean {
    return this.offered;
  }
  async cancel(explicit = true): Promise<CancelDispatch> {
    if (this.ended || !this.current()) return "inactive";
    if (this.cancelling) return this.cancelling;
    if (explicit && !this.offered && this.thread.stopping) return "inactive";
    // A click before the receipt arrives remains an explicit cancellation;
    // it is sent once upon receipt, not turned into a bare session cancel.
    if (!explicit && !this.cancelRequested) return "inactive";
    if (explicit && !this.offered) this.earlyCancel = true;
    this.cancelRequested = true;
    if (!this.thread.stopUnconfirmed) pauseQueue(this.thread, "stopped");
    if (this.thread.promptAdmission)
      this.thread.promptAdmission.cancelling = true;
    this.emit();
    if (this.receipt === null) return "pendingReceipt";
    const receipt = this.receipt;
    const early = this.earlyCancel;
    this.earlyCancel = false;
    this.cancelRequested = false;
    this.cancelling = Promise.resolve().then(
      async (): Promise<CancelDispatch> => {
        try {
          if (this.ended || !this.current()) return "inactive";
          const reply = await invoke<CancelReply>("session_prompt_cancel", {
            agentId: this.thread.agentId,
            cwd: this.thread.cwd,
            sessionId: this.thread.nativeSessionId,
            connectionId: this.thread.connectionId,
            promptToken: this.token,
            receiptId: receipt,
          });
          if (this.ended || !this.current()) return "inactive";
          if (reply.receiptId !== receipt) throw new Error("receipt");
          if (reply.outcome === "cancelledBeforeOffer") {
            // Keep queued blocks and attachments. drainPrompt removes only its
            // tentative display after the matching rejected admission returns.
            if (this.offered) throw new Error("late cancellation");
            this.cancelledBeforeOffer = true;
            this.unconfirmedWaitingStop = false;
            if (this.thread.promptAdmission)
              this.thread.promptAdmission.notice = S.cancelled;
          } else if (reply.outcome !== "cancelRequested") {
            throw new Error("unconfirmed");
          } else if (early && !this.endingObserved) {
            this.unconfirmedWaitingStop = false;
            this.onEarlyStopAcknowledged();
          }
          return "acknowledged";
        } catch {
          if (!this.ended && this.current() && this.thread.promptAdmission) {
            this.thread.promptAdmission.notice = S.unconfirmed;
            if (early && !this.endingObserved)
              this.preserveUnconfirmedWaitingStop();
          }
          return "unconfirmed";
        } finally {
          this.cancelling = null;
          if (!this.ended && this.current() && this.thread.promptAdmission) {
            this.thread.promptAdmission.cancelling = false;
            this.emit();
          }
        }
      },
    );
    return this.cancelling;
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.cancelRequested = false;
    this.channel.onmessage = () => {};
    if (this.current()) this.thread.promptAdmission = null;
    this.onEnd();
  }
}
