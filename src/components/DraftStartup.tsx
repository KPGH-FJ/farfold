import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { draftPersistence } from "../runtime/drafts";
import { DRAFT_STRINGS, useDraftSaveStatus } from "../runtime/draft_storage";
import { threads } from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { conversationReadState } from "../runtime/conversation_read_state";
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
  const saveAttempt = useRef(0);
  const [startupError, setStartupError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [exitReadError, setExitReadError] = useState<string | null>(null);
  const saveAndExit = async (token: number) => {
    currentExit.current = token;
    const attempt = ++saveAttempt.current;
    setExitToken(token);
    setExitError(false);
    setExitReadError(null);
    try {
      threads.pauseQueuesForExit();
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
      await invoke("app_exit_after_save", { token });
    } catch {
      if (currentExit.current !== token || saveAttempt.current !== attempt)
        return;
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
      const stopDeferred = await listen<number>(
        "app:exit-deferred",
        (event) => {
          if (currentExit.current !== event.payload) return;
          currentExit.current = null;
          setExitToken(null);
          setExitError(false);
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
        {exitError && (
          <div className="draft-exit-error" role="alert">
            <span>
              {exitReadError ??
                setup.error ??
                status.error ??
                DRAFT_STRINGS.saveFailed}
            </span>
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
  return (
    <main className="main" style={{ padding: 32 }}>
      <p
        role={setup.error || status.error || startupError ? "alert" : "status"}
      >
        {setup.error ??
          status.error ??
          (!setup.ready ? SETUP_STORAGE_STRINGS.loading : null) ??
          (startupError ? DRAFT_STRINGS.loadFailed : DRAFT_STRINGS.loading)}
      </p>
      {(setup.error || status.error || startupError) && (
        <button
          type="button"
          className="btn"
          onClick={() => setRetry((v) => v + 1)}
        >
          {STRINGS.common.retry}
        </button>
      )}
    </main>
  );
}
