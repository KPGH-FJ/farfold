import { HistoryReplayBuffer } from "./history_replay";
import { requireReadableHistory } from "./session_recovery";
import type { OpenResult } from "./session_open_types";

/** A wire discriminator, not validation of a known update subtype. Preserve
 * unknown/null/partial own update payloads before interpreting local controls. */
export function hasOwnUpdate(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    Object.prototype.hasOwnProperty.call(event, "update")
  );
}

export function isHistoryMarkerShape(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, "kind") &&
    Object.prototype.hasOwnProperty.call(value, "openToken") &&
    value.kind === "session_history_complete" &&
    typeof value.openToken === "string"
  );
}

export function isOwnerHistoryMarker(event: unknown, token: string): boolean {
  return (
    isHistoryMarkerShape(event) &&
    (event as Record<string, unknown>).openToken === token
  );
}

/** One existing open's temporary replay coordination, never an admission queue. */
export class SessionOpenReplay {
  private buffered = new HistoryReplayBuffer();
  readonly token = crypto.randomUUID();
  private complete = false;
  private lost = false;
  private delivered: (() => void) | null = null;

  receiveMarker(event: unknown): boolean {
    if (!isOwnerHistoryMarker(event, this.token)) return false;
    this.buffered.mark(this.token);
    this.complete = true;
    this.delivered?.();
    return true;
  }

  push(event: unknown): void {
    this.buffered.push(event);
    if (
      !hasOwnUpdate(event) &&
      (event as { kind?: unknown } | null)?.kind === "connectionLost"
    ) {
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
