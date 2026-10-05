import type { ThreadState } from "./session_types";

const owners = new WeakSet<ThreadState>();
const revisions = new WeakMap<ThreadState, number>();

/** A different pause writer revokes ownership even when its reason is identical. */
export function forgetConfigurationPause(s: ThreadState): void {
  owners.delete(s);
  revisions.set(s, configurationPauseRevision(s) + 1);
}
export function configurationPauseRevision(s: ThreadState): number {
  return revisions.get(s) ?? 0;
}
export function ownsConfigurationPause(s: ThreadState): boolean {
  if (s.queuePaused !== "unavailable" && owners.has(s))
    forgetConfigurationPause(s);
  return owners.has(s);
}
export function markConfigurationPause(s: ThreadState): void {
  if (s.queuePaused === "unavailable") owners.add(s);
}
