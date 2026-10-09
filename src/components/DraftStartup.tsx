import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { draftPersistence } from "../runtime/drafts";
import { DRAFT_STRINGS, useDraftSaveStatus } from "../runtime/draft_storage";
import { threads } from "../runtime/sessions";
import { StorageRecovery } from "./StorageRecovery";
import { conversationReadState } from "../runtime/conversation_read_state";
import { exitNeedsReview, EXIT_IMPACT as E } from "../runtime/exit_impact";
import { WorkspaceDialog } from "./WorkspaceDialog";
import {
  setupStorage,
  useSetupStorage,
  SETUP_STORAGE_STRINGS,
} from "../runtime/setup_storage";

/** Mount editable surfaces only after the previous unsent work is read. */
export function DraftStartup({ children }: { children: ReactNode }) {
  const status = useDraftSaveStatus();
  const setup = useSetupStorage();
  const [connected, setConnected] = useState(false);
  const [exitError, setExitError] = useState(false);
  const [exitToken, setExitToken] = useState<number | null>(null);
  const currentExit = useRef<number | null>(null);
  const restartingExit = useRef<number | null>(null);
  const saveAttempt = useRef(0);
  const [startupError, setStartupError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [exitReadError, setExitReadError] = useState<string | null>(null);
  const [exitReview, setExitReview] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState(false);
  const cancelExit = async (token: number) => {
    if (currentExit.current !== token) return;
    const attempt = ++saveAttempt.current;
    try {
      await invoke("app_exit_cancel", { token });
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
      currentExit.current = null;
      setExitReview(null);
      setExitToken(null);
      setExitError(false);
      setCancelError(false);
      draftPersistence.lockInteraction(false);
      // A cancelled quit never resumes queues or retries requests.
    } catch {
      if (currentExit.current === token && saveAttempt.current === attempt)
        setCancelError(true);
    }
  };
  const saveAndExit = async (
    token: number,
    confirmActivity = false,
    restarting = false,
  ) => {
    if (restarting) restartingExit.current = token;
    else if (currentExit.current !== token) restartingExit.current = null;
    currentExit.current = token;
    const attempt = ++saveAttempt.current;
    setExitToken(token);
    setExitError(false);
    setExitReadError(null);
    setCancelError(false);
    threads.pauseQueuesForExit();
    draftPersistence.lockInteraction(true);
    if (
      restartingExit.current !== token &&
      !confirmActivity &&
      exitNeedsReview()
    ) {
      setExitReview(token);
      return;
    }
    setExitReview(null);
    try {
      await Promise.all([draftPersistence.flush(), setupStorage.flush()]);
      // Include replies received while other metadata was being saved. A failed
      // read without any unread edits is unrelated to this exit's save barrier.
      await conversationReadState.flushPending().catch((reason) => {
        if (currentExit.current === token && saveAttempt.current === attempt)
          setExitReadError(conversationReadState.snapshot().error);
        throw reason;
      });
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
      await invoke("app_exit_after_save", {
        token,
        ...(confirmActivity ? { confirmActivity: true } : {}),
      });
    } catch (reason) {
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
      if (
        String(reason).replace(/^Error:\s*/, "") ===
        "EXIT_CONFIRMATION_REQUIRED"
      ) {
        setExitReview(token);
        return;
      }
      draftPersistence.lockInteraction(false);
      setExitError(true);
    }
  };
  useEffect(() => {
    let active = true;
    const unlisteners: (() => void)[] = [];
    setStartupError(false);
    void (async () => {
      await Promise.all([draftPersistence.load(), setupStorage.load()]);
      const off = await listen<number>("app:save-before-exit", (event) => {
        void saveAndExit(event.payload);
      });
      if (!active) {
        off();
        return;
      }
      unlisteners.push(off);
      const stopRestart = await listen<number>(
        "app:save-before-restart",
        (event) => {
          void saveAndExit(event.payload, false, true);
        },
      );
      if (!active) {
        stopRestart();
        return;
      }
      unlisteners.push(stopRestart);
      const stopDeferred = await listen<number>(
        "app:exit-deferred",
        (event) => {
          if (currentExit.current !== event.payload) return;
          currentExit.current = null;
          setExitToken(null);
          setExitError(false);
          setExitReview(null);
        },
      );
      if (!active) {
        stopDeferred();
        return;
      }
      unlisteners.push(stopDeferred);
      await invoke("app_drafts_ready");
      if (active) setConnected(true);
    })().catch(() => {
      if (active) setStartupError(true);
    });
    return () => {
      active = false;
      unlisteners.forEach((off) => off());
    };
  }, [retry]);
  if (status.ready && setup.ready && connected)
    return (
      <>
        {exitReview !== null && (
          <WorkspaceDialog
            title={E.title}
            onClose={() => void cancelExit(exitReview)}
          >
            <div className="workspace-dialog-body">
              <p>{E.work}</p>
              <p>{E.consequence}</p>
              <p>{E.saved}</p>
              {cancelError && <p role="alert">{E.cancelFailed}</p>}
            </div>
            <footer>
              <button
                type="button"
                className="btn"
                onClick={() => void cancelExit(exitReview)}
              >
                {E.stay}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveAndExit(exitReview, true)}
              >
                {E.exit}
              </button>
            </footer>
          </WorkspaceDialog>
        )}
        {exitError && (
          <div className="draft-exit-error" role="alert">
            <span>
              {cancelError
                ? E.cancelFailed
                : (exitReadError ??
                  setup.error ??
                  status.error ??
                  DRAFT_STRINGS.saveFailed)}
            </span>
            {restartingExit.current !== exitToken && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (exitToken !== null) void cancelExit(exitToken);
                }}
              >
                {E.stay}
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (exitToken !== null) void saveAndExit(exitToken);
              }}
            >
              {DRAFT_STRINGS.retry}
            </button>
          </div>
        )}
        <div
          style={{ display: "contents" }}
          inert={
            Boolean(status.interactionLocked) ||
            (exitToken !== null && !exitError)
          }
        >
          {children}
        </div>
      </>
    );
  const failure =
    setup.error ??
    status.error ??
    (startupError ? DRAFT_STRINGS.loadFailed : null);
  if (failure)
    return (
      <StorageRecovery
        message={failure}
        onRetry={async () => {
          await Promise.all([draftPersistence.load(), setupStorage.load()]);
          setRetry((value) => value + 1);
        }}
      />
    );
  return (
    <main className="main" style={{ padding: 32 }}>
      <p role="status">
        {!setup.ready ? SETUP_STORAGE_STRINGS.loading : DRAFT_STRINGS.loading}
      </p>
    </main>
  );
}
