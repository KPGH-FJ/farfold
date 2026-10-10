import type { RefObject } from "react";

export type WorkLocationIntent = Readonly<{
  isCurrent: () => boolean;
  apply: (path: string) => Promise<boolean>;
}>;
export type WorktreeManagementRequest = Readonly<{
  key: string;
  cwd: string | null;
  target: WorkLocationIntent | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
}>;
let request: WorktreeManagementRequest | null = null;
const listeners = new Set<() => void>();
function publish() {
  for (const fn of listeners) fn();
}
/** One transient management surface, independent of any draft's lifetime. */
export const worktreeManagement = {
  snapshot: () => request,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  open(input: Omit<WorktreeManagementRequest, "key">) {
    request = Object.freeze({ ...input, key: crypto.randomUUID() });
    publish();
    return request;
  },
  close(expected: WorktreeManagementRequest) {
    if (request !== expected) return;
    request = null;
    publish();
  },
};
