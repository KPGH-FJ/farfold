import { useConversationArchiveJobs } from "../runtime/conversation_archive_jobs";
import { ConversationArchiveJobsStatus } from "./ConversationArchiveJobsStatus";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { draftPersistence } from "../runtime/drafts";
import { DRAFT_STRINGS, useDraftSaveStatus } from "../runtime/draft_storage";
import { threads } from "../runtime/sessions";
import { StorageRecovery } from "./StorageRecovery";
import { conversationReadState } from "../runtime/conversation_read_state";
import {
  exitNeedsReview,
  hasUnknownFinishedFileCopies,
  EXIT_IMPACT as E,
} from "../runtime/exit_impact";
import {
  hasUnsettledFileCopies,
  useFileCopyJobs,
} from "../runtime/file_copy_jobs";
import { FileCopyJobsStatus } from "./FileCopyJobsStatus";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorktreeManagementHost } from "./WorktreeManagementHost";
import {
  setupStorage,
  useSetupStorage,
  SETUP_STORAGE_STRINGS,
} from "../runtime/setup_storage";

/** Mount editable surfaces only after the previous unsent work is read. */
export function DraftStartup({ children }: { children: ReactNode }) {
  const status = useDraftSaveStatus();
  const setup = useSetupStorage();
  // Subscribe even when the underlying file view is closed or inert for quit.
  useFileCopyJobs();
  useConversationArchiveJobs();
  const copying = hasUnsettledFileCopies();
  const unknownCopy = hasUnknownFinishedFileCopies();
  const [connected, setConnected] = useState(false);
  const [exitError, setExitError] = useState(false);
  const [exitToken, setExitToken] = useState<number | null>(null);
  const currentExit = useRef<number | null>(null);
  const restartingExit = useRef<number | null>(null);
  const saveAttempt = useRef(0);
  const cancelRequest = useRef<{ token: number; attempt: number } | null>(null);
  const exitInteraction = useRef<(() => void) | null>(null);
  const [startupError, setStartupError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [exitReadError, setExitReadError] = useState<string | null>(null);
  const [exitReview, setExitReview] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState(false);
  const [readsSettled, setReadsSettled] = useState(false);
  const [backendCopyReview, setBackendCopyReview] = useState(false);
  const [backendWorktreeReview, setBackendWorktreeReview] = useState(false);
  const [cancellingExit, setCancellingExit] = useState<number | null>(null);
  const releaseExitInteraction = () => {
    const release = exitInteraction.current;
    exitInteraction.current = null;
    release?.();
  };
  const cancelExit = async (token: number) => {
    if (currentExit.current !== token || cancelRequest.current?.token === token)
      return;
    const attempt = ++saveAttempt.current;
    const request = { token, attempt };
    cancelRequest.current = request;
    setCancellingExit(token);
    setCancelError(false);
    try {
      await invoke("app_exit_cancel", { token });
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
      currentExit.current = null;
      setExitReview(null);
      setExitToken(null);
      setExitError(false);
      setCancelError(false);
      releaseExitInteraction();
      // A cancelled quit never resumes queues or retries requests.
    } catch {
      if (currentExit.current === token && saveAttempt.current === attempt)
        setCancelError(true);
    } finally {
      if (cancelRequest.current === request) {
        cancelRequest.current = null;
        setCancellingExit(null);
      }
    }
  };
  const saveAndExit = async (
    token: number,
    confirmActivity = false,
    restarting = false,
  ) => {
    // A repeated quit event cannot supersede this owner's pending withdrawal.
    if (cancelRequest.current?.token === token) return;
    if (restarting) restartingExit.current = token;
    else if (currentExit.current !== token) restartingExit.current = null;
    currentExit.current = token;
    const attempt = ++saveAttempt.current;
    setExitToken(token);
    setExitError(false);
    setExitReadError(null);
    setCancelError(false);
    setBackendCopyReview(false);
    setBackendWorktreeReview(false);
    setCancellingExit(null);
    threads.pauseQueuesForExit();
    exitInteraction.current ??= draftPersistence.acquireInteractionLock();
    if (
      hasUnsettledFileCopies() ||
      (!confirmActivity &&
        (hasUnknownFinishedFileCopies() ||
          (restartingExit.current !== token && exitNeedsReview())))
    ) {
      setExitReview(token);
      return;
    }
    setExitReview(null);
    try {
      await Promise.all([draftPersistence.flush(), setupStorage.flush()]);
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
      // Replies and stop receipts can update either store while the other is
      // saving. Check both in the same turn before acknowledging this exit.
      for (;;) {
        await conversationReadState.flushPending().catch((reason) => {
          if (currentExit.current === token && saveAttempt.current === attempt)
            setExitReadError(conversationReadState.snapshot().error);
          throw reason;
        });
        if (currentExit.current !== token || saveAttempt.current !== attempt)
          return;
        if (!draftPersistence.isSaved(draftPersistence.revision())) {
          await draftPersistence.flush();
          if (currentExit.current !== token || saveAttempt.current !== attempt)
            return;
        } else if (!conversationReadState.hasPending()) {
          break;
        }
      }
      // A save may have started while metadata was flushing. The backend
      // repeats admission atomically through the actual native quit.
      if (
        hasUnsettledFileCopies() ||
        (!confirmActivity && hasUnknownFinishedFileCopies())
      ) {
        setExitReview(token);
        return;
      }
      await invoke("app_exit_after_save", {
        token,
        ...(confirmActivity ? { confirmActivity: true } : {}),
      });
    } catch (reason) {
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
      const code = String(reason).replace(/^Error:\s*/, "");
      if (
        code === "EXIT_CONFIRMATION_REQUIRED" ||
        code === "FILE_COPY_EXIT_BLOCKED" ||
        code === "WORKTREE_EXIT_BLOCKED"
      ) {
        setBackendCopyReview(code === "FILE_COPY_EXIT_BLOCKED");
        setBackendWorktreeReview(code === "WORKTREE_EXIT_BLOCKED");
        setExitReview(token);
        return;
      }
      releaseExitInteraction();
      setExitError(true);
    }
  };
  useEffect(() => {
    let active = true;
    const unlisteners: (() => void)[] = [];
    setStartupError(false);
    setReadsSettled(false);
    void (async () => {
      const loaded = await Promise.allSettled([
        draftPersistence.load(),
        setupStorage.load(),
      ]);
      if (!active) return;
      setReadsSettled(true);
      if (loaded.some((result) => result.status === "rejected"))
        throw new Error("startup content unavailable");
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
          releaseExitInteraction();
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
      currentExit.current = null;
      saveAttempt.current++;
      cancelRequest.current = null;
      releaseExitInteraction();
    };
  }, [retry]);
  if (status.ready && setup.ready && connected)
    return (
      <div className="draft-workspace">
        {exitReview !== null && (
          <WorkspaceDialog
            title={E.title}
            busy={cancellingExit === exitReview}
            onClose={() => void cancelExit(exitReview)}
          >
            <div className="workspace-dialog-body">
              <p>{E.work}</p>
              <p>{E.consequence}</p>
              <p>{E.saved}</p>
              {copying ? (
                <p role="status">{E.copying}</p>
              ) : backendWorktreeReview ? (
                <p role="status">{E.worktreeReview}</p>
              ) : unknownCopy ? (
                <p role="status">{E.copyUnknown}</p>
              ) : backendCopyReview ? (
                <p role="status">{E.copyReview}</p>
              ) : null}
              <FileCopyJobsStatus />
              <ConversationArchiveJobsStatus />
              {cancellingExit === exitReview && (
                <p role="status">{E.cancelling}</p>
              )}
              {cancelError && <p role="alert">{E.cancelFailed}</p>}
            </div>
            <footer>
              <button
                type="button"
                className="btn"
                disabled={cancellingExit === exitReview}
                onClick={() => void cancelExit(exitReview)}
              >
                {E.stay}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  copying ||
                  backendWorktreeReview ||
                  cancellingExit === exitReview
                }
                onClick={() => void saveAndExit(exitReview, true)}
              >
                {E.exit}
              </button>
            </footer>
          </WorkspaceDialog>
        )}
        {exitToken !== null &&
          restartingExit.current !== exitToken &&
          exitReview === null &&
          !exitError && (
            <WorkspaceDialog
              title={E.title}
              busy={cancellingExit === exitToken}
              onClose={() => void cancelExit(exitToken)}
            >
              <div className="workspace-dialog-body">
                <p role="status">
                  {cancellingExit === exitToken ? E.cancelling : E.waiting}
                </p>
                <p>{E.waitingNote}</p>
                {cancelError && <p role="alert">{E.cancelFailed}</p>}
              </div>
              <footer>
                <button
                  type="button"
                  className="btn"
                  disabled={cancellingExit === exitToken}
                  onClick={() => void cancelExit(exitToken)}
                >
                  {E.stay}
                </button>
              </footer>
            </WorkspaceDialog>
          )}
        {exitError && (
          <div className="draft-exit-error" role="alert">
            <span>
              {cancellingExit === exitToken
                ? E.cancelling
                : cancelError
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
                disabled={cancellingExit === exitToken}
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
              disabled={cancellingExit === exitToken}
              onClick={() => {
                if (exitToken !== null) void saveAndExit(exitToken);
              }}
            >
              {DRAFT_STRINGS.retry}
            </button>
          </div>
        )}
        <div
          className="draft-workspace-main"
          inert={
            Boolean(status.interactionLocked) ||
            (exitToken !== null && !exitError)
          }
        >
          {children}
        </div>
        <WorktreeManagementHost />
      </div>
    );
  const failure =
    setup.error ??
    status.error ??
    (startupError ? DRAFT_STRINGS.loadFailed : null);
  if (failure && readsSettled)
    return (
      <StorageRecovery
        restoreKeys={[
          ...(!status.ready ? ["unsentWork.v1" as const] : []),
          ...(!setup.ready ? ["agentSetup.v1" as const] : []),
        ]}
        message={failure}
        onRetry={async () => {
          setReadsSettled(false);
          await Promise.allSettled([
            draftPersistence.load(),
            setupStorage.load(),
          ]);
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
