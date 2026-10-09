import { sealStreams } from "./session_projection";
import type { ThreadState } from "./session_types";

/** Temporary IPC delivery buffer for one open/preview request, never stored.
 * A matching marker acknowledges only its preceding events. Repeated markers
 * cannot expand that prefix, and later events remain available as live work. */
export class HistoryReplayBuffer {
  private events: unknown[] = [];
  private readonly boundaries = new Map<string, number>();

  push(event: unknown): void {
    this.events.push(event);
  }

  mark(token: string): void {
    if (!this.boundaries.has(token))
      this.boundaries.set(token, this.events.length);
  }

  complete(token: string): boolean {
    return this.boundaries.has(token);
  }

  prefix(token: string): unknown[] {
    const end = this.boundaries.get(token);
    return end === undefined ? [] : this.events.slice(0, end);
  }

  take(token?: string): { prefix: unknown[]; following: unknown[] } {
    const end =
      token === undefined
        ? this.events.length
        : (this.boundaries.get(token) ?? 0);
    const prefix = this.events.slice(0, end);
    const following = this.events.slice(end);
    this.clear();
    return { prefix, following };
  }

  clear(): void {
    this.events = [];
    this.boundaries.clear();
  }
}

/** The supported replay shapes have no original time; do not invent it from
 * today's load. Call before applying the subsequent live part of the channel. */
export function finishHistoryPrefix(state: ThreadState): void {
  sealStreams(state);
  for (const item of state.items) {
    if ("time" in item) item.time = 0;
    if (item.kind === "tool") {
      item.call.startedAt = 0;
      item.call.endedAt = undefined;
    }
  }
}
