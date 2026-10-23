import { sealStreams } from "./session_projection";
import type { ThreadState } from "./session_types";

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
