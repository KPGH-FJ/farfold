import { HistoryReplayBuffer } from "./history_replay";
import { requireReadableHistory } from "./session_recovery";
import type { OpenResult } from "./session_open_types";

/** One existing open's temporary replay coordination, never an admission queue. */
export class SessionOpenReplay {
  private buffered = new HistoryReplayBuffer();
  readonly token = crypto.randomUUID();
  private complete = false;
  private lost = false;
  private delivered: (() => void) | null = null;

  receiveMarker(event: unknown): boolean {
    const received = event as { kind?: unknown; openToken?: unknown } | null;
    if (received?.kind !== "session_history_complete") return false;
    if (received.openToken === this.token) {
      this.buffered.mark(this.token);
      this.complete = true;
      this.delivered?.();
    }
    return true;
  }

  push(event: unknown): void {
    this.buffered.push(event);
    if ((event as { kind?: unknown } | null)?.kind === "connectionLost") {
      this.lost = true;
      this.delivered?.();
    }
  }

  get needsMarker(): boolean {
    return !this.complete && !this.lost;
  }

  waitForMarker(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      this.delivered = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  requireReadable(agentId: string, result: OpenResult): void {
    this.delivered = null;
    requireReadableHistory(
      agentId,
      result,
      this.buffered.prefix(this.token),
      this.complete,
      this.lost,
    );
  }

  take(resumed: boolean): { prefix: unknown[]; following: unknown[] } {
    return this.buffered.take(resumed ? this.token : undefined);
  }

  clear(): void {
    this.buffered.clear();
  }
}
