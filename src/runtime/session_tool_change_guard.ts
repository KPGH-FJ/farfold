import type { ThreadState } from "./session_types";
import { threads } from "./sessions";

export const claimSessionToolChange = (s: ThreadState, operationId: string) =>
  threads.toolChanges.claim(s, operationId);
export const settleSessionToolChange = (s: ThreadState, operationId: string) =>
  threads.toolChanges.settle(s, operationId);
export const savedSessionToolChange = (s: ThreadState, operationId: string) =>
  threads.toolChanges.saved(s, operationId);
export const hasSessionToolChange = (s: ThreadState, operationId?: string) =>
  threads.toolChanges.has(s, operationId);
export const subscribeSessionToolChange = (listener: () => void) =>
  threads.toolChanges.subscribe(listener);
export const markSessionToolChangeUnknown = (
  s: ThreadState,
  operationId: string,
) => threads.toolChanges.markUnknown(s, operationId);
export const releaseUnsentSessionToolChange = (
  s: ThreadState,
  operationId: string,
) => threads.toolChanges.releaseUnsent(s, operationId);
