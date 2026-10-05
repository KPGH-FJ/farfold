import { useSyncExternalStore } from "react";

// User intent for this app lifetime, separate from saved preparation. This
// prevents mounting/refreshing a view from undoing an explicit disconnect.
const paused = new Map<string, symbol>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

export function subscribeConnectionIntent(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isAutomaticConnectionAllowed(
  agentId: string | null | undefined,
) {
  return !agentId || !paused.has(agentId);
}

/** Rollback belongs only to this attempt; a newer user decision wins. */
export function pauseAutomaticConnection(agentId: string): () => void {
  const previous = paused.get(agentId);
  const token = Symbol(agentId);
  paused.set(agentId, token);
  if (!previous) changed();
  return () => {
    if (paused.get(agentId) !== token) return;
    if (previous) paused.set(agentId, previous);
    else {
      paused.delete(agentId);
      changed();
    }
  };
}

/** Call only for an explicit user connect, selection, or open action. */
export function allowAutomaticConnection(agentId: string) {
  if (paused.delete(agentId)) changed();
}

export function useAutomaticConnectionAllowed(
  agentId: string | null | undefined,
) {
  return useSyncExternalStore(
    subscribeConnectionIntent,
    () => isAutomaticConnectionAllowed(agentId),
    () => isAutomaticConnectionAllowed(agentId),
  );
}
