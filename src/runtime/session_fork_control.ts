/** Presentation of one actual owner and its retained copy operation.
 * The runtime owns admission, dispatch, late results and child recovery. */
export interface SessionForkControl {
  owner: object;
  phase:
    | "idle"
    | "pending"
    | "unknown"
    | "created-unavailable"
    | "ready"
    | "rejected";
  blockedReason?: string;
  child?: {
    nativeSessionId: string;
    threadKey?: string;
    title?: string;
  };
  message?: string;
  historyPoint?: { messageId: string; preview?: string };
  isCurrent: () => boolean;
  start: () => void;
  continue?: () => void;
  openChild?: () => void;
  /** Only a confirmed released terminal result may prepare another review. */
  prepareNew?: () => void;
}
