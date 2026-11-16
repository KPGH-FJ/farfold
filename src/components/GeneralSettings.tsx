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
import type { ThemeMode, ThemeStatus } from "../runtime/theme";
import { InterfaceScaleControl } from "./InterfaceScale";
import { NotificationTestControl } from "./NotificationTestControl";
import { UpdateDialog } from "./UpdateDialog";
import { SendingSettings } from "./SendingSettings";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { useDiagnosticsReview } from "../runtime/diagnostics";
import type { AgentCardModel } from "../runtime/agents";
import { AutoArchiveSettings } from "./AutoArchiveSettings";
import "../general-settings.css";
import "../settings-library-redesign.css";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";
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
  kind: "update" | "shortcuts" | "privacy" | "notifications";
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useDiagnosticsReview();
  const notifications = useDesktopNotifications();
  const notificationHeading = useRef<HTMLHeadingElement | null>(null);
  const [notificationFocus, setNotificationFocus] = useState(0);
  // Run after a dismissed dialog's passive focus cleanup has restored its opener.
  useEffect(() => {
    if (!notificationFocus) return;
    notificationHeading.current?.scrollIntoView({ block: "start" });
    notificationHeading.current?.focus({ preventScroll: true });
  }, [notificationFocus]);

  // Menu-driven requests (检查更新/键盘快捷键/数据与隐私) open the matching
  // panel once, then the request is handed back to be cleared.
  const handledRequest = useRef(0);
  useEffect(() => {
    if (!request || handledRequest.current === request.request) return;
    handledRequest.current = request.request;
    if (request.kind === "notifications") {
      setPanel(null);
      setUpdateOpen(false);
      setDiagnosticsOpen(false);
      setNotificationFocus(request.request);
    } else if (request.kind === "update") setUpdateOpen(true);
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

  return (
    <div className="general-page settings-redesign">
      <header className="general-heading">
        <h1>{STRINGS.general.heading}</h1>
        <p>{STRINGS.general.sub}</p>
      </header>
      <nav className="settings-section-index" aria-label={R.pageIndex}>
        {[
          ["general-appearance", STRINGS.general.appearance],
          ["general-organization", STRINGS.general.organization],
          ["general-notifications", R.notifications],
          ["general-shortcuts", STRINGS.general.shortcuts],
          ["general-maintenance", STRINGS.general.maintenance],
          ["general-privacy", R.privacy],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            onClick={() => {
              const target = document.getElementById(id);
              target?.scrollIntoView({ block: "start" });
              target?.focus({ preventScroll: true });
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="general-section" aria-labelledby="general-appearance">
        <div className="general-section-title">
          <h2 id="general-appearance" tabIndex={-1}>
            {STRINGS.general.appearance}
          </h2>
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
              disabled={!themeStatus.ready}
              aria-disabled={themeStatus.saving || undefined}
              onClick={() => {
                if (!themeStatus.saving) onThemeMode(mode);
              }}
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

        <InterfaceScaleControl />
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
      <AutoArchiveSettings onOpenArchived={onOpenArchived} />
      <section
        className="general-section"
        aria-labelledby="general-notifications"
      >
        <h2 id="general-notifications" tabIndex={-1} ref={notificationHeading}>
          {R.notifications}
        </h2>
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
        <div className="general-setting-row">
          <div>
            <strong>{P.successNotification}</strong>
            <p id="desktop-success-notification-hint">{N.successHint}</p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            role="switch"
            aria-label={P.successNotification}
            aria-checked={notifications.successEnabled}
            aria-describedby="desktop-success-notification-hint desktop-notification-system"
            disabled={!notifications.ready || notifications.saving}
            onClick={() =>
              void notifications.setSuccessEnabled(
                !notifications.successEnabled,
              )
            }
          >
            {notifications.saving
              ? N.saving
              : !notifications.ready && !notifications.error
                ? N.reading
                : notifications.successEnabled
                  ? N.enabled
                  : N.disabled}
          </button>
        </div>
        <p id="desktop-notification-system" className="auth-note">
          {notificationPermissionLabel(notifications)} {N.systemHint}
        </p>
        {(notifications.enabled || notifications.successEnabled) &&
          notifications.systemAlert === false && (
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
        <details className="general-archive-rules">
          <summary>{R.notificationDetails}</summary>
          <p className="auth-note">{N.navigationHint}</p>
          {notifications.clickRequiresRunning && (
            <p className="auth-note">{N.runningNavigationHint}</p>
          )}
          {(notifications.systemAlert === null ||
            notifications.systemSound === null) && (
            <p className="auth-note">{N.systemOptionsUnknown}</p>
          )}
        </details>
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
        <NotificationTestControl
          ready={notifications.ready}
          saving={notifications.saving}
          error={notifications.error}
          sound={notifications.sound}
        />
      </section>
      <section className="general-section" aria-labelledby="general-shortcuts">
        <div className="general-section-title">
          <h2 id="general-shortcuts" tabIndex={-1}>
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
        <h2 id="general-maintenance" tabIndex={-1}>
          {STRINGS.general.maintenance}
        </h2>
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
      </section>
      <section className="general-section" aria-labelledby="general-privacy">
        <h2 id="general-privacy" tabIndex={-1}>
          {R.privacy}
        </h2>
        <p className="general-caption">{R.privacySummary}</p>
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
