import { hasOwnUpdate } from "./session_open_replay";
import type { SessionDeliveryObserver } from "./session_delivery_observer";
import type { ThreadState } from "./session_types";

interface Ports {
  key(): string | null;
  owns(key: string): boolean;
  thread(key: string): ThreadState | undefined;
  inquiry(event: unknown): boolean;
  recheck(event: unknown): void;
  marker(event: unknown): boolean;
  historyFailed(): boolean;
  failedLive(): boolean;
  applyFailed(state: ThreadState, event: unknown): void;
  apply(key: string, event: unknown): void;
  receiving(): boolean;
  buffer(event: unknown): void;
}

/** The existing open/replay routing, with the consumption boundary explicit. */
export function openDeliveryConsumer(
  observation: SessionDeliveryObserver,
  ports: Ports,
): (input: unknown) => void {
  return (input) =>
    observation.receive(input, (event) => {
      const key = ports.key();
      // A replaced same-key channel must not consume control events either.
      if (key && !ports.owns(key)) return "discarded";
      if (!hasOwnUpdate(event)) {
        if (!key && ports.inquiry(event)) return "consumed";
        ports.recheck(event);
      }
      if (ports.marker(event)) return "consumed";
      if (key) {
        const received = event as { kind?: unknown } | null;
        const state = ports.thread(key);
        if (
          !state ||
          (ports.historyFailed() &&
            !ports.failedLive() &&
            (hasOwnUpdate(event) || received?.kind !== "connectionLost"))
        )
          return "discarded";
        if (ports.historyFailed()) ports.applyFailed(state, event);
        else ports.apply(key, event);
        return "consumed";
      }
      if (!ports.receiving()) return "discarded";
      ports.buffer(event);
      return "buffered";
    });
}
