import { invoke } from "@tauri-apps/api/core";
import {
  SessionDeliveryFlow,
  type DeliveryTransfer,
} from "./session_delivery_flow";

export type DeliveryOutcome = "consumed" | "discarded" | "error";
type Consumption = DeliveryOutcome | "buffered";
interface Stamp {
  openToken: string;
  observerId: string;
  sequence: string;
  sampleId?: string;
}
interface Sample {
  stamp: Stamp;
  position?: number;
}
const counter = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;

/** Observes one actual delivery at a time, without retaining event bodies.
 * A receipt means this sample was synchronously consumed, not that React
 * painted, that earlier events were consumed, or that memory is bounded. */
export class SessionDeliveryObserver {
  private observerId?: string;
  private lastSample = 0n;
  private pending?: Sample;
  private enqueued = 0;
  private drained = 0;
  private deferred = 0;
  private retired = false;
  private flow: SessionDeliveryFlow;

  constructor(
    private agentId: string,
    private openToken: string,
  ) {
    this.flow = new SessionDeliveryFlow(agentId, openToken);
  }

  /** This flow's next native pull only; it neither buffers direct delivery nor
   * changes actual control Promise consumption or external Agent execution. */
  pause(): () => void {
    return this.flow.pause();
  }

  async settle(deadline: number): Promise<void> {
    await this.flow.settle(deadline);
    // Transport transfer is not business consumption. Configuration events in
    // a live view are synchronous; other outstanding transfers cannot certify it.
    if (this.retired || this.enqueued !== this.drained || this.deferred)
      throw new Error("delivery consumption pending");
  }

  receive(
    input: unknown,
    consume: (event: unknown) => Consumption | Promise<DeliveryOutcome>,
  ): void {
    if (this.flow.receive(input, (event) => this.consume(event, consume)))
      return;
    this.consume(input, consume);
  }

  private consume(
    input: unknown,
    consume: (event: unknown) => Consumption | Promise<DeliveryOutcome>,
  ): DeliveryTransfer {
    let event = input;
    let sample: Sample | undefined;
    if (
      input &&
      typeof input === "object" &&
      "farfoldDelivery" in input &&
      "event" in input
    ) {
      // Always preserve the actual channel payload. Serialization and Tauri
      // enqueue can interleave across senders, so this stamp is never an event
      // ordering, deduplication or payload-admission gate.
      event = input.event;
      const stamp = input.farfoldDelivery as Stamp | null;
      if (
        stamp &&
        stamp.openToken === this.openToken &&
        typeof stamp.observerId === "string" &&
        /^[0-9a-f]{32}$/.test(stamp.observerId) &&
        counter(stamp.sequence) &&
        (this.observerId === undefined || stamp.observerId === this.observerId)
      ) {
        this.observerId = stamp.observerId;
        if (
          counter(stamp.sampleId) &&
          !this.pending &&
          BigInt(stamp.sampleId) > this.lastSample
        ) {
          this.lastSample = BigInt(stamp.sampleId);
          sample = { stamp };
          this.pending = sample;
        }
      }
      // Unwrap exactly once. Agent-controlled inner JSON is never a receipt.
    }
    // Internal callers/tests can use unobserved values. All three real Tauri
    // command channels supply the trusted outer envelope above.
    if (this.retired) {
      if (sample) this.finish(sample, "discarded");
      return "discarded";
    }
    try {
      const result = consume(event);
      if (result === "buffered") {
        this.enqueued += 1;
        if (sample) sample.position = this.enqueued;
      } else if (result instanceof Promise) {
        this.deferred += 1;
        // Only a sampled delivery can produce a receipt; unsampled control
        // failures are also observed so they cannot become unhandled promises.
        void result.then(
          (outcome) => {
            this.deferred -= 1;
            if (sample) this.finish(sample, outcome);
          },
          () => {
            this.deferred -= 1;
            if (sample) this.finish(sample, "error");
          },
        );
        return "deferred";
      } else if (sample) this.finish(sample, result);
      return result;
    } catch (error) {
      if (sample) this.finish(sample, "error");
      throw error;
    }
  }

  consumeBuffered(consume: () => void): void {
    this.drained += 1;
    const sample = this.pending;
    const matches = sample?.position === this.drained;
    try {
      consume();
      if (sample && matches) this.finish(sample, "consumed");
    } catch (error) {
      if (sample && matches) this.finish(sample, "error");
      throw error;
    }
  }

  discardBuffered(count = this.enqueued - this.drained): void {
    this.drained += Math.max(0, count);
    const sample = this.pending;
    if (sample?.position !== undefined && sample.position <= this.drained)
      this.finish(sample, "discarded");
  }

  dispose(): void {
    this.retired = true;
    this.flow.dispose();
    if (this.pending) this.finish(this.pending, "discarded");
  }

  private finish(sample: Sample, outcome: DeliveryOutcome): void {
    if (this.pending !== sample) return;
    this.pending = undefined;
    const { observerId, sampleId, sequence } = sample.stamp;
    // No retry queue. A failed/undelivered receipt remains pending at the host.
    try {
      void invoke("session_delivery_observation_ack", {
        agentId: this.agentId,
        openToken: this.openToken,
        receipt: { observerId, sampleId, sequence, outcome },
      }).catch(() => {});
    } catch {
      // A disappearing IPC bridge cannot undo or interrupt actual consumption.
    }
  }
}
