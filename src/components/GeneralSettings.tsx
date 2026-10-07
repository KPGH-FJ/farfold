/**
 * 设置 · 通用（F-settings-general）：外观 / 自动归档 / 更新 / 诊断 / 版本。
 */
import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  ArrowRightIcon,
  BellIcon,
  DownloadSimpleIcon,
  KeyboardIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "@phosphor-icons/react";
import { uiError } from "../runtime/ui_error";
import { STRINGS } from "../runtime/strings";
import { threads } from "../runtime/sessions";
import type { ThemeMode, ThemeStatus } from "../runtime/theme";
import { UpdateDialog } from "./UpdateDialog";
import { SendingSettings } from "./SendingSettings";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { useDiagnosticsReview } from "../runtime/diagnostics";
import type { AgentCardModel } from "../runtime/agents";
import {
  ARCHIVE_STRINGS,
  retryAutoArchive,
  useAutoArchive,
} from "../runtime/auto_archive";
import "../general-settings.css";
import {
  GeneralSettingsDialog,
  generalShortcuts,
} from "./GeneralSettingsDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { SETTINGS_PRESENTATION as P } from "../runtime/settings_presentation_strings";
import { SENDING_STRINGS } from "../runtime/sending_strings";
import {
  NOTIFICATION_STRINGS as N,
  useDesktopNotifications,
  notificationPermissionLabel,
} from "../runtime/desktop_notifications";

export interface GeneralSettingsRequest {
  kind: "update" | "shortcuts" | "privacy";
  request: number;
}

interface GeneralSettingsProps {
  request?: GeneralSettingsRequest | null;
  onRequestHandled?: () => void;
  onOpenConversation?: (key: string) => void;
  onOpenArchived?: () => void;
  onOpenAgents?: (agentId?: string) => void;
  agents?: AgentCardModel[];
  defaultCwd?: string | null;
  themeMode: ThemeMode;
  themeStatus: ThemeStatus;
  onThemeMode: (mode: ThemeMode) => void;
}

export function GeneralSettings({
  request,
  onRequestHandled,
  onOpenConversation,
  onOpenArchived,
  onOpenAgents,
  agents = [],
  defaultCwd = null,
  themeMode,
  themeStatus,
  onThemeMode,
}: GeneralSettingsProps) {
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  const [version, setVersion] = useState<string>("…");
  const [updateOpen, setUpdateOpen] = useState(false);
  const [panel, setPanel] = useState<
    "shortcuts" | "privacy" | "sending" | null
  >(null);
  const [archiveDays, setArchiveDays] = useState<number | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(true);
  const archiveInFlight = useRef(false);
  const archiveReading = useRef(true);
  const [archiveRead, setArchiveRead] = useState(0);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useDiagnosticsReview();
  const autoArchive = useAutoArchive();
  const notifications = useDesktopNotifications();

  // Menu-driven requests (检查更新/键盘快捷键/数据与隐私) open the matching
  // panel once, then the request is handed back to be cleared.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (!request || handledRequest.current === request.request) return;
    handledRequest.current = request.request;
    if (request.kind === "update") setUpdateOpen(true);
    else setPanel(request.kind);
    onRequestHandled?.();
  }, [request, onRequestHandled]);

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((value) => {
        if (!cancelled) setVersion(value);
      })
      .catch(() => {
        if (!cancelled) setVersion("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    archiveReading.current = true;
    setArchiveLoading(true);
    setArchiveError(null);
    void threads
      .readAutoArchiveDays()
      .then((saved) => {
        if (!cancelled) {
          setArchiveDays(saved);
        }
      })
      .catch((reason) => {
        if (!cancelled)
          setArchiveError(uiError(reason, STRINGS.general.settingsLoadFailed));
      })
      .finally(() => {
        if (!cancelled) {
          archiveReading.current = false;
          setArchiveLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [archiveRead]);

  const setDays = async (requested: string) => {
    if (
      archiveDays === null ||
      archiveInFlight.current ||
      archiveReading.current ||
      requested.trim() === ""
    )
      return;
    const days = Number(requested);
    if (!Number.isFinite(days) || days < 0) return;
    const clean = Math.floor(days);
    archiveInFlight.current = true;
    setArchiveSaving(true);
    setArchiveError(null);
    try {
      await threads.setAutoArchiveDays(clean);
      setArchiveDays(clean);
    } catch (reason) {
      setArchiveError(uiError(reason, STRINGS.general.settingsSaveFailed));
    } finally {
      archiveInFlight.current = false;
      setArchiveSaving(false);
    }
  };

  return (
    <div className="general-page">
      <header className="general-heading">
        <h1>{STRINGS.general.heading}</h1>
        <p>{STRINGS.general.sub}</p>
      </header>
      <section className="general-section" aria-labelledby="general-appearance">
        <div className="general-section-title">
          <h2 id="general-appearance">{STRINGS.general.appearance}</h2>
          <span>{STRINGS.general.appearanceDesc}</span>
        </div>
        <div className="general-appearance">
          {(
            [
              {
                mode: "light",
                label: STRINGS.general.appearancePaper,
                Icon: SunIcon,
              },
              {
                mode: "dark",
                label: STRINGS.general.appearanceDark,
                Icon: MoonIcon,
              },
              {
                mode: "system",
                label: STRINGS.general.appearanceSystem,
                Icon: MonitorIcon,
              },
            ] as const
          ).map(({ mode, label, Icon }) => (
            <button
              type="button"
              key={mode}
              className="general-theme-card"
              aria-pressed={themeMode === mode}
              disabled={!themeStatus.ready || themeStatus.saving}
              onClick={() => onThemeMode(mode)}
            >
              <span
                className={`general-theme-swatch ${mode}`}
                aria-hidden="true"
              >
                <i />
                <b />
                <em />
              </span>
              <span>
                <Icon size={17} />
                {label}
                {themeMode === mode && (
                  <CheckCircleIcon size={16} weight="fill" />
                )}
              </span>
            </button>
          ))}
        </div>

        {themeStatus.saving && (
          <div role="status">{STRINGS.general.settingsSaving}</div>
        )}
        {themeStatus.error && (
          <div className="ac-error" role="alert">
            {themeStatus.error}
            {!themeStatus.ready && (
              <button
                type="button"
                className="btn btn-text"
                onClick={themeStatus.retry}
              >
                {STRINGS.common.retry}
              </button>
            )}
          </div>
        )}
      </section>
      <section
        className="general-section"
        aria-labelledby="general-organization"
      >
        <h2 id="general-organization">{STRINGS.general.organization}</h2>
        <div className="general-setting-row">
          <div>
            <strong>{STRINGS.general.autoArchive}</strong>
            <p>{ARCHIVE_STRINGS.description}</p>
          </div>
          <select
            aria-label={STRINGS.general.autoArchive}
            disabled={archiveDays === null || archiveSaving || archiveLoading}
            value={archiveDays ?? ""}
            onChange={(event) => void setDays(event.target.value)}
          >
            {archiveDays === null && (
              <option value="">{STRINGS.common.loading}</option>
            )}
            {[0, 7, 30, 90].map((days) => (
              <option key={days} value={days}>
                {days === 0
                  ? STRINGS.general.archiveOff
                  : STRINGS.general.archiveAfter(days)}
              </option>
            ))}
            {archiveDays !== null && ![0, 7, 30, 90].includes(archiveDays) && (
              <option value={archiveDays}>
                {STRINGS.general.archiveAfter(archiveDays)}
              </option>
            )}
          </select>
        </div>
        <details className="general-archive-rules">
          <summary>{ARCHIVE_STRINGS.rules}</summary>
          <ul>
            <li>{ARCHIVE_STRINGS.known}</li>
            <li>{ARCHIVE_STRINGS.protected}</li>
            <li>{ARCHIVE_STRINGS.restored}</li>
          </ul>
        </details>
        <div className="general-archive-actions">
          <p role={autoArchive.error ? "alert" : "status"}>
            {autoArchive.error ??
              (!autoArchive.ready || autoArchive.running
                ? ARCHIVE_STRINGS.checking
                : archiveDays === 0
                  ? ARCHIVE_STRINGS.off
                  : ARCHIVE_STRINGS.candidates(autoArchive.count))}
          </p>
          <button
            type="button"
            className="btn btn-text"
            disabled={autoArchive.running || !archiveDays}
            onClick={() => void retryAutoArchive()}
          >
            {ARCHIVE_STRINGS.retry}
          </button>
          {onOpenArchived && (
            <button
              type="button"
              className="btn btn-text"
              onClick={onOpenArchived}
            >
              {ARCHIVE_STRINGS.view}
            </button>
          )}
        </div>
        {archiveSaving && (
          <div className="general-feedback" role="status">
            {STRINGS.general.settingsSaving}
          </div>
        )}
        {archiveError && (
          <div className="ac-error" role="alert">
            {archiveError}
            <button
              type="button"
              className="btn btn-text"
              disabled={archiveSaving || archiveLoading}
              onClick={() => {
                archiveReading.current = true;
                setArchiveLoading(true);
                setArchiveRead((n) => n + 1);
              }}
            >
              {STRINGS.common.retry}
            </button>
          </div>
        )}
        <div className="general-setting-row">
          <div>
            <strong>
              <BellIcon size={16} aria-hidden="true" />
              {P.notification}
            </strong>
            <p id="desktop-notification-hint">{N.hint}</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            role="switch"
            aria-label={P.notification}
            aria-checked={notifications.enabled}
            aria-describedby="desktop-notification-hint desktop-notification-system"
            disabled={!notifications.ready || notifications.saving}
            onClick={() =>
              void notifications.setEnabled(!notifications.enabled)
            }
          >
            {notifications.saving
              ? N.saving
              : !notifications.ready && !notifications.error
                ? N.reading
                : notifications.enabled
                  ? N.enabled
                  : N.disabled}
          </button>
        </div>
        <p id="desktop-notification-system" className="auth-note">
          {notificationPermissionLabel(notifications)} {N.systemHint}
        </p>
        {notifications.enabled && notifications.systemAlert === false && (
          <p className="auth-note">{N.alertsDisabled}</p>
        )}
        <button
          type="button"
          className="btn btn-text"
          disabled={notifications.saving}
          onClick={() => void notifications.retry()}
        >
          {N.retry}
        </button>
        <p className="auth-note">{N.navigationHint}</p>
        {notifications.clickRequiresRunning && (
          <p className="auth-note">{N.runningNavigationHint}</p>
        )}
        {(notifications.systemAlert === null ||
          notifications.systemSound === null) && (
          <p className="auth-note">{N.systemOptionsUnknown}</p>
        )}
        {notifications.error && (
          <div className="ac-error" role="alert">
            {notifications.error}
          </div>
        )}
        {notifications.submissionError && (
          <p className="ac-error" role="status">
            {notifications.submissionError}
          </p>
        )}
        <div className="general-setting-row">
          <div>
            <strong>{P.sound}</strong>
            <p>{N.soundHint}</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            role="switch"
            aria-label={P.sound}
            aria-checked={notifications.sound}
            disabled={!notifications.ready || notifications.saving}
            onClick={() => void notifications.setSound(!notifications.sound)}
          >
            {notifications.sound ? N.enabled : N.disabled}
          </button>
        </div>
        {notifications.sound && notifications.systemSound === false && (
          <p className="auth-note">{N.systemSoundDisabled}</p>
        )}
      </section>
      <section className="general-section" aria-labelledby="general-shortcuts">
        <div className="general-section-title">
          <h2 id="general-shortcuts">
            <KeyboardIcon size={18} />
            {STRINGS.general.shortcuts}
          </h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={(event) => {
              panelTrigger.current = event.currentTarget;
              setPanel("shortcuts");
            }}
          >
            {P.shortcuts}
          </button>
        </div>
        <dl className="general-shortcuts">
          {generalShortcuts.slice(0, 3).map(([label, keys]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        className="general-section"
        aria-labelledby="general-maintenance"
      >
        <h2 id="general-maintenance">{STRINGS.general.maintenance}</h2>
        <div className="general-setting-row">
          <div>
            <strong>Farfold {version || "—"}</strong>
            <p>{STRINGS.general.updateDesc}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setUpdateOpen(true)}
          >
            {STRINGS.general.checkUpdate}
          </button>
        </div>

        <div className="general-setting-row">
          <div>
            <strong>{STRINGS.general.diagnostics}</strong>
            <p>{STRINGS.general.diagnosticsDesc}</p>
            {diagnostics.phase === "done" && diagnostics.path && (
              <p role="status">
                {STRINGS.general.diagnosticsDone(diagnostics.path)}
              </p>
            )}
            {diagnostics.error && (
              <p role="alert">
                {STRINGS.general.diagnosticsFailed}：{diagnostics.error}
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setDiagnosticsOpen(true)}
          >
            <DownloadSimpleIcon size={16} />
            {diagnostics.phase === "exporting"
              ? STRINGS.general.exportingDiagnostics
              : STRINGS.general.exportDiagnostics}
          </button>
        </div>
        <div className="general-setting-row">
          <div>
            <strong>{P.privacyTitle}</strong>
            <p>{P.privacyHint}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={(event) => {
              panelTrigger.current = event.currentTarget;
              setPanel("privacy");
            }}
          >
            {P.privacyOpen}
            <ArrowRightIcon size={15} aria-hidden="true" />
          </button>
        </div>
      </section>
      <section className="general-section general-advanced">
        <details>
          <summary>{P.advanced}</summary>
          <div className="general-setting-row">
            <div>
              <strong>{P.sending}</strong>
              <p>{P.sendingHint}</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={(event) => {
                panelTrigger.current = event.currentTarget;
                setPanel("sending");
              }}
            >
              {P.manage}
            </button>
          </div>
        </details>
      </section>
      {panel === "sending" && (
        <WorkspaceDialog
          title={SENDING_STRINGS.title}
          onClose={() => setPanel(null)}
          returnFocusRef={panelTrigger}
        >
          <SendingSettings
            agents={agents}
            defaultCwd={defaultCwd}
            onClose={() => setPanel(null)}
          />
        </WorkspaceDialog>
      )}
      {(panel === "shortcuts" || panel === "privacy") && (
        <GeneralSettingsDialog
          page={panel}
          onClose={() => setPanel(null)}
          returnFocusRef={panelTrigger}
        />
      )}
      {updateOpen && (
        <UpdateDialog
          onClose={() => setUpdateOpen(false)}
          onOpenConversation={onOpenConversation}
          agents={agents}
          onOpenAgents={onOpenAgents}
        />
      )}
      {diagnosticsOpen && (
        <DiagnosticsDialog onClose={() => setDiagnosticsOpen(false)} />
      )}
    </div>
  );
}
