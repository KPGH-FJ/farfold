import { useSyncExternalStore } from "react";
import { browserSurfaceGuard } from "../runtime/browser_surface";
import { BROWSER_WORKSPACE_STRINGS as S } from "../runtime/browser_workspace_strings";
import "../browser-workspace.css";

/** Stays outside routes and content panes, so a failed close always has an exit. */
export function BrowserSurfaceNotice() {
  const state = useSyncExternalStore(
    browserSurfaceGuard.subscribe,
    browserSurfaceGuard.getSnapshot,
    browserSurfaceGuard.getSnapshot,
  );
  if (!state.failed && !state.busy) return null;
  return (
    <div
      className="browser-surface-notice"
      role={state.failed ? "alert" : "status"}
    >
      <span>{state.failed ? S.transitionFailed : S.transitioning}</span>
      {state.failed && (
        <button type="button" onClick={() => browserSurfaceGuard.retry()}>
          {S.transitionRetryClose}
        </button>
      )}
    </div>
  );
}
