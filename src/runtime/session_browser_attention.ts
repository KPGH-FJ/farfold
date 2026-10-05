import type { ThreadState } from "./session_types";
import { browserSharingAttention } from "./browser_sharing_attention";
import { observeBrowserDesktopNotification } from "./desktop_notifications";

/** Mirror only a live decision into the existing attention/send predicates. */
export function observeBrowserRequests(
  thread: (key: string) => ThreadState | undefined,
  changed: (key: string) => void,
): () => void {
  return browserSharingAttention.subscribe((key) => {
    const state = thread(key);
    if (!state) return;
    const requestId = state.connectionLost
      ? null
      : browserSharingAttention.pendingRequestId(key);
    if ((state.browserReadRequestId ?? null) === requestId) return;
    state.browserReadRequestId = requestId;
    if (requestId)
      observeBrowserDesktopNotification(
        state,
        requestId,
        () =>
          thread(key) === state &&
          browserSharingAttention.pendingRequestId(key) === requestId,
      );
    changed(key);
  });
}
