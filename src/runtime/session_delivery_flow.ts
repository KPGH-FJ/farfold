import { invoke } from "@tauri-apps/api/core";
import { STRINGS } from "./strings";

export type DeliveryTransfer =
  "consumed" | "discarded" | "error" | "buffered" | "deferred";
interface Pulled {
  sequence: string;
  event: unknown;
}
interface PullPause {
  interests: number;
  ready: Promise<void>;
  resume(): void;
}
/** A wake contains no Agent body. A single owned pull runs at a time; its
 * receipt releases transport storage, not history/React ownership or task work. */
export class SessionDeliveryFlow {
  private queueId?: string;
  private running = false;
  private wakeAgain = false;
  private retired = false;
  private lastSequence = 0n;
  private paused?: PullPause;
  constructor(
    private agentId: string,
    private openToken: string,
  ) {}

  /** Pause only the next native pull. The current body and its receipt still
   * finish, and no payload is held here. Each caller resumes only its own
   * interest; a disposed/replaced flow can never be revived by an old handle. */
  pause(): () => void {
    if (this.retired) return () => {};
    if (!this.paused) {
      let resume!: () => void;
      const ready = new Promise<void>((resolve) => {
        resume = resolve;
      });
      this.paused = { interests: 0, ready, resume };
    }
    const pause = this.paused;
    pause.interests += 1;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (this.retired || this.paused !== pause) return;
      pause.interests -= 1;
      if (pause.interests !== 0) return;
      this.paused = undefined;
      pause.resume();
    };
  }
  receive(
    input: unknown,
    consume: (event: unknown) => DeliveryTransfer,
  ): boolean {
    if (
      !input ||
      typeof input !== "object" ||
      !("farfoldDeliveryWake" in input)
    )
      return false;
    const wake = input.farfoldDeliveryWake as Record<string, unknown> | null;
    if (
      !wake ||
      wake.openToken !== this.openToken ||
      typeof wake.queueId !== "string" ||
      !/^[0-9a-f]{32}$/.test(wake.queueId) ||
      (this.queueId !== undefined && this.queueId !== wake.queueId)
    )
      return true;
    this.queueId = wake.queueId;
    if (this.retired) {
      this.release();
      return true;
    }
    this.wakeAgain = true;
    if (!this.running) void this.drain(consume);
    return true;
  }
  private args() {
    return {
      agentId: this.agentId,
      openToken: this.openToken,
      queueId: this.queueId,
    };
  }
  private async drain(consume: (event: unknown) => DeliveryTransfer) {
    this.running = true;
    try {
      do {
        this.wakeAgain = false;
        while (!this.retired) {
          // There is no await between this owner check and starting a pull.
          // A resumed wait loops back to recheck a newer pause or retirement.
          const paused = this.paused;
          if (paused) {
            await paused.ready;
            continue;
          }
          const pulled = await invoke<Pulled | null>(
            "session_delivery_pull",
            this.args(),
          );
          if (this.retired) {
            if (pulled && typeof pulled.sequence === "string") {
              await invoke("session_delivery_ack", {
                ...this.args(),
                receipt: { sequence: pulled.sequence, outcome: "discarded" },
              });
            }
            return;
          }
          if (pulled === null) break;
          if (
            !pulled ||
            typeof pulled.sequence !== "string" ||
            !/^[1-9][0-9]{0,19}$/.test(pulled.sequence) ||
            BigInt(pulled.sequence) !== this.lastSequence + 1n ||
            !("event" in pulled)
          )
            throw new Error("delivery sequence");
          let outcome: DeliveryTransfer;
          try {
            outcome = consume(pulled.event);
          } catch {
            outcome = "error";
          }
          if (this.retired) outcome = "discarded";
          const acknowledged = await invoke<boolean>("session_delivery_ack", {
            ...this.args(),
            receipt: {
              sequence: pulled.sequence,
              outcome:
                outcome === "buffered"
                  ? "transferred_replay"
                  : outcome === "deferred"
                    ? "transferred_control"
                    : outcome,
            },
          });
          if (this.retired) return;
          if (!acknowledged || outcome === "error")
            throw new Error("delivery incomplete");
          this.lastSequence = BigInt(pulled.sequence);
        }
      } while (this.wakeAgain && !this.retired);
    } catch {
      if (!this.retired) {
        // This is a local delivery failure, not proof that the Agent stopped.
        this.dispose();
        try {
          consume({
            kind: "deliveryUnavailable",
            message: STRINGS.repair.deliveryInterrupted,
          });
        } catch {
          // The original consumer has already failed. No body retry or silent
          // second projection can make that outcome reliable.
        }
      }
    } finally {
      this.running = false;
    }
  }
  dispose() {
    this.retired = true;
    const paused = this.paused;
    this.paused = undefined;
    paused?.resume();
    this.release();
  }
  private release() {
    if (!this.queueId) return;
    try {
      void invoke("session_delivery_retire", this.args()).catch(() => {});
    } catch {
      // Real window destruction independently retires the native owner.
    }
  }
}
