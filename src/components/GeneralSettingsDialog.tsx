import { useState, useSyncExternalStore, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { shortcutLabel, usesMacShortcuts } from "../runtime/platform_shortcuts";
import {
  BookOpenIcon,
  FolderIcon,
  KeyIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { STRINGS } from "../runtime/strings";
import { SETTINGS_PRESENTATION as P } from "../runtime/settings_presentation_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { threads } from "../runtime/sessions";
import { hasPendingRequests } from "../runtime/session_types";
import { uiError } from "../runtime/ui_error";

/** Active work, pending requests or unconfirmed outcomes keep the destructive
 * action locked; the backend applies the same gate again before deleting. */
function workInFlight(): boolean {
  for (const thread of threads.getSnapshot().threads.values()) {
    if (
      thread.running ||
      thread.submitting ||
      thread.stopping ||
      thread.stopUnconfirmed ||
      thread.uncertainPrompt ||
      thread.connectionOutcomeUnknown ||
      hasPendingRequests(thread)
    )
      return true;
  }
  return false;
}

export const generalShortcuts = [
  [STRINGS.general.shortcutNew, shortcutLabel("N")],
  [STRINGS.general.shortcutSearch, shortcutLabel("K")],
  [P.openSettings, shortcutLabel(",")],
  [P.searchAlias, shortcutLabel("P", true)],
  [P.closeDialog, "Esc"],
  [STRINGS.general.shortcutSend, "Enter"],
  [
    STRINGS.general.shortcutNewline,
    usesMacShortcuts() ? "⇧ Enter" : "Shift+Enter",
  ],
] as const;

/** The danger zone inside 数据与隐私: an explicit clear of Farfold-owned data
 *  with its deletion/preservation scope, plus complete-uninstall guidance. */
function PrivacyDataControls() {
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "done">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  useSyncExternalStore(
    threads.subscribe,
    threads.getSnapshot,
    threads.getSnapshot,
  );
  const clear = async () => {
    if (phase !== "confirm") return;
    setPhase("working");
    setError(null);
    try {
      await invoke("farfold_data_clear");
      setPhase("done");
    } catch (reason) {
      setError(uiError(reason, P.clearDataFailed));
      setPhase("confirm");
    }
  };
  return (
    <>
      <section className="settings-clear-data">
        <div>
          <h3>{P.clearDataTitle}</h3>
          <p>{P.clearDataHint}</p>
        </div>
        {phase === "idle" && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={workInFlight()}
              onClick={() => setPhase("confirm")}
            >
              {P.clearData}
            </button>
            {workInFlight() && (
              <p className="auth-note">{P.clearDataBlocked}</p>
            )}
          </>
        )}
        {phase === "confirm" || phase === "working" ? (
          <div className="access-confirm" role="alert">
            <div className="settings-clear-scope">
              <strong>{P.clearDataDeleteTitle}</strong>
              <ul>
                {P.clearDataDeletes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <strong>{P.clearDataKeepTitle}</strong>
              <ul>
                {P.clearDataKeeps.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            {error && <p role="alert">{error}</p>}
            <div className="ac-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={phase !== "confirm"}
                onClick={() => void clear()}
              >
                {phase === "working" ? P.clearDataWorking : P.clearDataConfirm}
              </button>
              <button
                type="button"
                className="btn btn-text"
                disabled={phase === "working"}
                onClick={() => {
                  setError(null);
                  setPhase("idle");
                }}
              >
                {P.clearDataCancel}
              </button>
            </div>
          </div>
        ) : null}
        {phase === "done" && (
          <p role="status" className="auth-note">
            {P.clearDataDone}
          </p>
        )}
      </section>
      <section className="settings-uninstall">
        <div>
          <h3>{P.uninstallTitle}</h3>
          <p>{P.uninstallHint}</p>
        </div>
      </section>
    </>
  );
}

export function GeneralSettingsDialog({
  page,
  onClose,
  returnFocusRef,
}: {
  page: "shortcuts" | "privacy";
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const icons = [FolderIcon, BookOpenIcon, KeyIcon, SparkleIcon];
  return (
    <WorkspaceDialog
      title={page === "shortcuts" ? STRINGS.general.shortcuts : P.privacy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {page === "shortcuts" ? (
        <dl className="settings-shortcut-list">
          {generalShortcuts.map(([label, keys]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="settings-privacy-list">
          {P.data.map(({ title, text }, index) => {
            const Icon = icons[index];
            return (
              <section key={title}>
                <Icon size={21} aria-hidden="true" />
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </section>
            );
          })}
          <p className="general-caption">{P.dataScope}</p>
          <PrivacyDataControls />
        </div>
      )}
      <footer>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {page === "shortcuts" ? P.close : P.understood}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
