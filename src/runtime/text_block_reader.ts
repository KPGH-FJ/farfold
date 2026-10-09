import type { PreviewContentStatus } from "./preview_capture";
import {
  readTextBlock,
  textBlockFailure,
  type TextBlockPreview,
  type TextBlockFailureCode,
} from "./text_block_preview";
export interface TextBlockReaderState {
  block: TextBlockPreview;
  phase: "ready" | "loading" | "failed" | "paused";
  requested?: number;
  code?: TextBlockFailureCode;
}
/** One outstanding native receipt; cancelling/hiding withdraws presentation only. */
export class TextBlockReader {
  private value: TextBlockReaderState;
  private listeners = new Set<() => void>();
  private flight: { show: boolean; index: number } | null = null;
  private active = true;
  onStatus?: (status: PreviewContentStatus) => void;
  constructor(
    initial: TextBlockPreview,
    private read = readTextBlock,
  ) {
    this.value = { block: initial, phase: "ready" };
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: TextBlockReaderState) {
    this.value = next;
    this.onStatus?.({
      file: next.block.file,
      state: next.phase,
      code: next.code,
      readInFlight: Boolean(this.flight),
    });
    this.listeners.forEach((listener) => listener());
  }
  setActive(active: boolean) {
    this.active = active;
    if (!active) this.cancel();
  }
  isBusy = () => Boolean(this.flight);
  cancel = () => {
    if (!this.flight) return;
    this.flight.show = false;
    this.publish({ ...this.value, phase: "paused" });
  };
  async go(index: number): Promise<void> {
    if (
      !this.active ||
      this.flight ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.value.block.blockCount
    )
      return;
    const owner = { index, show: true };
    this.flight = owner;
    this.publish({
      ...this.value,
      phase: "loading",
      requested: index,
      code: undefined,
    });
    try {
      const block = await this.read(this.value.block.file, index);
      this.publish(
        owner.show && this.active
          ? { block, phase: "ready" }
          : { ...this.value, phase: "paused" },
      );
    } catch (error) {
      // A hidden receipt still reports native pending/busy, rather than losing
      // that evidence to a view AbortSignal race.
      this.publish({
        ...this.value,
        phase: "failed",
        code: textBlockFailure(error),
      });
    } finally {
      this.flight = null;
      this.publish({ ...this.value });
    }
  }
}
