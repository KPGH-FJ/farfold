import type { ThreadState } from "./session_types";

const owners = new WeakSet<ThreadState>();
const revisions = new WeakMap<ThreadState, number>();

/** Reconcile a private opening baseline without inventing an external pause
 * writer. Existing real writer revisions must remain available to recheck. */
export function clearConfigurationPauseOwner(s: ThreadState): void {
  owners.delete(s);
}

/** A different pause writer revokes ownership even when its reason is identical. */
export function forgetConfigurationPause(s: ThreadState): void {
  clearConfigurationPauseOwner(s);
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
