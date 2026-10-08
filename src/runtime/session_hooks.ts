import { useCallback, useSyncExternalStore } from "react";
import { threads } from "./sessions";
import type { ThreadState, ThreadsSnapshot } from "./sessions";

/**
 * React bindings for the conversation store. Extracted from `sessions.ts`
 * to keep that file within the per-file size limit; everything is
 * re-exported from `./sessions`, so existing imports keep working.
 */
export function useThreadsSnapshot(): ThreadsSnapshot {
  return useSyncExternalStore(threads.subscribe, threads.getSnapshot);
}

export function useThread(key: string | null | undefined): ThreadState | null {
  const subscribe = useCallback(
    (fn: () => void) => (key ? threads.subscribeThread(key, fn) : () => {}),
    [key],
  );
  const getVersion = useCallback(
    () => (key ? threads.threadVersion(key) : 0),
    [key],
  );
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return key ? (threads.thread(key) ?? null) : null;
}
