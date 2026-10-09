import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
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
import { DangerConfirm } from "./DangerConfirm";
import { threads } from "../runtime/sessions";
import { hasPendingRequests } from "../runtime/session_types";
import "../settings-library-redesign.css";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
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
type ClearPhase = "idle" | "confirm" | "working" | "done";
function PrivacyDataControls({
  phase,
  setPhase,
}: {
  phase: ClearPhase;
  setPhase: (phase: ClearPhase) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const clearing = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useSyncExternalStore(
    threads.subscribe,
    threads.getSnapshot,
    threads.getSnapshot,
  );
  const clear = async () => {
    if (
      phase !== "confirm" ||
      clearing.current ||
      !acknowledged ||
      workInFlight()
    )
      return;
    clearing.current = true;
    setPhase("working");
    setError(null);
    try {
      await invoke("farfold_data_clear");
      setPhase("done");
    } catch (reason) {
      clearing.current = false;
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
          <DangerConfirm
            busy={phase === "working"}
            confirmDisabled={!acknowledged || workInFlight()}
            error={error}
            confirmLabel={
              phase === "working" ? P.clearDataWorking : P.clearDataConfirm
            }
            onConfirm={() => void clear()}
            cancelLabel={P.clearDataCancel}
            onCancel={() => {
              setError(null);
              setPhase("idle");
              setAcknowledged(false);
            }}
          >
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
              <label className="settings-clear-acknowledgement">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={phase === "working"}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                <span>{R.clearAcknowledgement}</span>
              </label>
              {workInFlight() && <p role="status">{P.clearDataBlocked}</p>}
            </div>
          </DangerConfirm>
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
          <details>
            <summary>{R.uninstallDetails}</summary>
            <p>{P.uninstallHint}</p>
          </details>
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
  const [phase, setPhase] = useState<ClearPhase>("idle");
  const busy = phase === "working" || phase === "done";
  const close = () => {
    if (!busy) onClose();
  };
  const icons = [FolderIcon, BookOpenIcon, KeyIcon, SparkleIcon];
  return (
    <WorkspaceDialog
      title={page === "shortcuts" ? STRINGS.general.shortcuts : P.privacy}
      onClose={close}
      busy={busy}
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
          <PrivacyDataControls phase={phase} setPhase={setPhase} />
        </div>
      )}
      <footer>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={close}
        >
          {page === "shortcuts" ? P.close : P.understood}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
