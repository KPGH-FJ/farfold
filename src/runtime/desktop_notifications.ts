import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { completion } from "./completion";
import type { ThreadState } from "./session_types";

export const NOTIFICATION_STRINGS = {
  hint: "在你离开 Farfold 时，提醒新的批准请求、提问和工作异常。提醒不包含对话内容。",
  systemHint: "是否实际显示仍由系统通知设置和专注模式决定。",
  permissionUnknown: "系统通知许可尚未确认，请重新检查。",
  permissionUnavailable:
    "系统通知暂不可用。请稍后重新检查；提醒仍使用之前的选择。",
  permissionPending: "开启提醒时，系统会询问是否允许 Farfold 通知。",
  permissionDenied:
    "系统未允许通知。请在系统设置中允许 Farfold 通知，再重新检查。",
  permissionAllowed: "系统已允许通知。",
  permissionQuiet: "系统已允许安静提醒。",
  alertsDisabled: "系统横幅已关闭，提醒可能只出现在通知中心。",
  systemOptionsUnknown: "横幅和声音的具体设置请在系统通知设置中查看。",
  navigationHint: "点击提醒可回到对应对话，不会自动连接或发送消息。",
  runningNavigationHint:
    "仅在 Farfold 仍运行时支持点击提醒回到对话；退出后不会通过提醒重新打开应用。",
  coldConversation: "这段对话尚未打开。你可以继续查看，消息不会自动发送。",
  openConversation: "查看这段对话",
  soundHint: "仅在系统允许声音时播放；关闭后提醒保持安静。",
  systemSoundDisabled: "系统当前未允许通知声音。",
  loadError: "提醒设置未能读取，桌面提醒保持关闭。请重试读取。",
  saveError: "提醒设置未能保存，仍使用之前的选择。",
  submitError: "上次提醒的提交结果未确认，不会自动重试。",
  reading: "正在读取…",
  saving: "正在保存…",
  enabled: "已开启",
  disabled: "已关闭",
  retry: "重新检查",
} as const;

function preferenceSaveError(error: unknown): string {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : null;
  switch (message) {
    case "系统通知许可尚未确认，请重新检查":
    case "系统通知许可尚未确认，原设置保持不变":
      return NOTIFICATION_STRINGS.permissionUnknown;
    case "系统通知暂不可用":
      return NOTIFICATION_STRINGS.permissionUnavailable;
    default:
      return NOTIFICATION_STRINGS.saveError;
  }
}

type NoticeKind = "approval" | "question" | "interrupted";
type NoticeSource = "agent" | "browser";
type DiagnosticPhase =
  | "none"
  | "observed"
  | "skipped"
  | "submitting"
  | "submitted"
  | "suppressed"
  | "unconfirmed";
type DiagnosticReason =
  | "none"
  | "foreground"
  | "not_ready"
  | "disabled"
  | "saving"
  | "preferences_changed"
  | "connection_changed"
  | "not_pending"
  | "submitted"
  | "suppressed"
  | "unconfirmed";
export interface DesktopNotificationDiagnostic {
  version: 1;
  frontend: {
    kind: NoticeKind | null;
    source: NoticeSource | null;
    phase: DiagnosticPhase;
    reason: DiagnosticReason;
    background: boolean | null;
    ready: boolean;
    enabled: boolean;
    saving: boolean;
  };
  // Existing submission identity is for matching the backend's last attempt.
  // Diagnostics export strips it; no conversation identity or contents enter here.
  backendAttempt: { rendererNonce: string; sequence: number } | null;
}
interface Notice {
  kind: NoticeKind;
  requestId?: string;
}
export type NotificationPermission =
  "not_determined" | "denied" | "authorized" | "provisional" | "unknown";
export interface NotificationPreference {
  enabled: boolean;
  sound: boolean;
  permission: NotificationPermission;
  systemAlert: boolean | null;
  systemSound: boolean | null;
  clickRequiresRunning: boolean;
}
function preference(value: unknown): NotificationPreference {
  if (!value || typeof value !== "object")
    throw new Error("invalid notification state");
  const v = value as Record<string, unknown>;
  if (
    typeof v.enabled !== "boolean" ||
    typeof v.sound !== "boolean" ||
    (v.systemAlert !== null && typeof v.systemAlert !== "boolean") ||
    (v.systemSound !== null && typeof v.systemSound !== "boolean") ||
    typeof v.clickRequiresRunning !== "boolean" ||
    ![
      "not_determined",
      "denied",
      "authorized",
      "provisional",
      "unknown",
    ].includes(String(v.permission))
  )
    throw new Error("invalid notification state");
  return v as unknown as NotificationPreference;
}
export function notificationPermissionLabel(
  state: NotificationPreference,
): string {
  switch (state.permission) {
    case "not_determined":
      return NOTIFICATION_STRINGS.permissionPending;
    case "denied":
      return NOTIFICATION_STRINGS.permissionDenied;
    case "authorized":
      return NOTIFICATION_STRINGS.permissionAllowed;
    case "provisional":
      return NOTIFICATION_STRINGS.permissionQuiet;
    default:
      return NOTIFICATION_STRINGS.permissionUnknown;
  }
}
interface PreferenceState extends NotificationPreference {
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
  submissionError: string | null;
}
interface NotificationPort {
  read(): Promise<unknown>;
  save(enabled: boolean, sound: boolean): Promise<unknown>;
  submit(
    kind: NoticeKind,
    sequence: number,
    targetKey: string,
    rendererNonce: string,
  ): Promise<unknown>;
  background(): boolean;
}

function activity(s: ThreadState): boolean {
  return Boolean(
    s.running ||
    s.submitting ||
    s.stopping ||
    s.stopUnconfirmed ||
    s.uncertainPrompt ||
    s.activeToolCallIds.length ||
    s.pendingPermissions.length ||
    s.pendingElicitations.length ||
    s.browserReadRequestId,
  );
}

/** Inspect the live pre-mutation state, never raw Agent text or history replay. */
function noticeFor(
  s: ThreadState,
  event: unknown,
  live: boolean,
): Notice | null {
  if (!live || !s.connectionId || !event || typeof event !== "object")
    return null;
  const e = event as Record<string, unknown>;
  const requestId = typeof e.requestId === "string" ? e.requestId : null;
  if (e.kind === "permissionRequest") {
    return requestId &&
      !s.pendingPermissions.some((p) => p.requestId === requestId) &&
      Array.isArray(e.options) &&
      e.options.length > 0
      ? { kind: "approval", requestId }
      : null;
  }
  if (e.kind === "elicitation") {
    return requestId &&
      !s.pendingElicitations.some((p) => p.requestId === requestId)
      ? { kind: "question", requestId }
      : null;
  }
  if (e.kind === "connectionLost") {
    return !s.connectionLost && e.closeReason === "unexpected" && activity(s)
      ? { kind: "interrupted" }
      : null;
  }
  if (e.kind === "serviceUnavailable") {
    return !s.sourceError && activity(s) ? { kind: "interrupted" } : null;
  }
  if (e.kind === "turnEnd" && activity(s)) {
    const { status } = completion({
      stopReason: typeof e.stopReason === "string" ? e.stopReason : undefined,
      error: typeof e.error === "string" ? e.error : undefined,
      failure: e.failure,
    });
    return status === "failed" || status === "unknown"
      ? { kind: "interrupted" }
      : null;
  }
  return null;
}

/** Settings and pending submissions only; no conversation/event persistence. */
export class DesktopNotifications {
  private state: PreferenceState = {
    enabled: false,
    sound: false,
    permission: "unknown",
    systemAlert: null,
    systemSound: null,
    clickRequiresRunning: true,
    ready: false,
    saving: false,
    error: null,
    submissionError: null,
  };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private revision = 0;
  private sequence = 0;
  private readonly rendererNonce = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  private decided = new Set<string>();
  private lastDiagnostic: DesktopNotificationDiagnostic = {
    version: 1,
    frontend: {
      kind: null,
      source: null,
      phase: "none",
      reason: "none",
      background: null,
      ready: false,
      enabled: false,
      saving: false,
    },
    backendAttempt: null,
  };

  constructor(private readonly port: NotificationPort) {}
  snapshot = () => this.state;
  diagnostic = (): DesktopNotificationDiagnostic => ({
    version: 1,
    frontend: { ...this.lastDiagnostic.frontend },
    backendAttempt: this.lastDiagnostic.backendAttempt
      ? { ...this.lastDiagnostic.backendAttempt }
      : null,
  });
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: Partial<PreferenceState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }
  load = (force = false): Promise<void> => {
    if ((this.state.ready && !force) || this.state.saving)
      return Promise.resolve();
    const revision = this.revision;
    return (this.loading ??= (async () => {
      this.publish({ error: null });
      try {
        const saved = preference(await this.port.read());
        if (revision === this.revision) this.publish({ ...saved, ready: true });
      } catch {
        // A malformed or unreadable record stays untouched, never default-written.
        if (revision === this.revision)
          this.publish({
            enabled: false,
            error: NOTIFICATION_STRINGS.loadError,
          });
      } finally {
        this.loading = null;
      }
    })());
  };
  setEnabled = (enabled: boolean): Promise<void> =>
    this.change(enabled, this.state.sound);
  setSound = (sound: boolean): Promise<void> =>
    this.change(this.state.enabled, sound);
  private change = async (enabled: boolean, sound: boolean): Promise<void> => {
    if (
      !this.state.ready ||
      this.state.saving ||
      (enabled === this.state.enabled && sound === this.state.sound)
    )
      return;
    this.revision++;
    this.publish({ saving: true, error: null });
    try {
      const saved = preference(await this.port.save(enabled, sound));
      if (saved.sound !== sound || (!enabled && saved.enabled))
        throw new Error("unconfirmed preference");
      this.publish({
        ...saved,
        submissionError: null,
        error:
          enabled && !saved.enabled ? notificationPermissionLabel(saved) : null,
      });
    } catch (error) {
      this.publish({ error: preferenceSaveError(error) });
    } finally {
      this.publish({ saving: false });
    }
  };

  observe = (s: ThreadState, event: unknown, live: boolean): void => {
    const notice = noticeFor(s, event, live);
    if (!notice) return;
    this.enqueue(s, notice, "agent", () => {
      if (!notice.requestId) return true;
      const requests =
        notice.kind === "approval"
          ? s.pendingPermissions
          : s.pendingElicitations;
      return requests.some(
        (p) => p.requestId === notice.requestId && p.status === "pending",
      );
    });
  };

  /** Browser approval has its own live owner; it is not an Agent event. */
  observeBrowserRequest = (
    s: ThreadState,
    requestId: string,
    stillPending: () => boolean,
  ): void => {
    const current = () =>
      !s.connectionLost &&
      s.browserReadRequestId === requestId &&
      stillPending();
    if (!s.connectionId || !requestId || !current()) return;
    this.enqueue(s, { kind: "approval", requestId }, "browser", current);
  };

  private enqueue(
    s: ThreadState,
    notice: Notice,
    source: NoticeSource,
    stillRelevant: () => boolean,
  ): void {
    const connection = s.connectionId;
    // Remember decisions after submission too: unresolved tool work can remain
    // active after repeated end/error receipts. New rounds/connections get their
    // own decision. This bounded memory never stores or persists Agent content.
    const token = JSON.stringify([
      source,
      connection,
      s.key,
      notice.kind,
      s.roundItemBase,
      notice.requestId ?? null,
    ]);
    if (this.decided.has(token)) return;
    this.decided.add(token);
    if (this.decided.size > 512)
      this.decided.delete(this.decided.values().next().value!);
    const candidate: DesktopNotificationDiagnostic = {
      version: 1,
      frontend: {
        kind: notice.kind,
        source,
        phase: "observed",
        reason: "none",
        background: null,
        ready: this.state.ready,
        enabled: this.state.enabled,
        saving: this.state.saving,
      },
      backendAttempt: null,
    };
    this.lastDiagnostic = candidate;
    const record = (
      phase: DiagnosticPhase,
      reason: DiagnosticReason,
      background = candidate.frontend.background,
      backendAttempt = candidate.backendAttempt,
      capturePreferences = true,
    ) => {
      // A late read or submit reply must never become a newer request's receipt.
      if (this.lastDiagnostic !== candidate) return;
      candidate.frontend = {
        ...candidate.frontend,
        phase,
        reason,
        background,
        ready: capturePreferences ? this.state.ready : candidate.frontend.ready,
        enabled: capturePreferences
          ? this.state.enabled
          : candidate.frontend.enabled,
        saving: capturePreferences
          ? this.state.saving
          : candidate.frontend.saving,
      };
      candidate.backendAttempt = backendAttempt;
    };
    // An event seen in the foreground is not a new event when focus later moves.
    const observedBackground = this.port.background();
    record("observed", "none", observedBackground);
    if (!observedBackground) {
      record("skipped", "foreground");
      return;
    }
    const revision = this.revision;
    void (async () => {
      try {
        // Let the synchronous event projection publish its pending card first.
        await Promise.resolve();
        if (!this.state.ready && !this.state.error) await this.load();
        const reason: DiagnosticReason | null = !this.state.ready
          ? "not_ready"
          : !this.state.enabled
            ? "disabled"
            : this.state.saving
              ? "saving"
              : revision !== this.revision
                ? "preferences_changed"
                : s.connectionId !== connection
                  ? "connection_changed"
                  : null;
        if (reason) {
          record("skipped", reason);
          return;
        }
        const currentBackground = this.port.background();
        record("observed", "none", currentBackground);
        if (!currentBackground) {
          record("skipped", "foreground");
          return;
        }
        // The state has now consumed the event. Do not notify an already answered,
        // expired or cancelled request after an asynchronous preference read.
        if (!stillRelevant()) {
          record("skipped", "not_pending");
          return;
        }
        const sequence = ++this.sequence;
        record("submitting", "none", currentBackground, {
          rendererNonce: this.rendererNonce,
          sequence,
        });
        const submitted = await this.port.submit(
          notice.kind,
          sequence,
          s.key,
          this.rendererNonce,
        );
        if (submitted !== "submitted" && submitted !== "suppressed")
          throw new Error("unconfirmed notification receipt");
        // Retain the actual gate-time preferences, not choices made while the
        // operating system's asynchronous submission was in flight.
        record(submitted, submitted, undefined, undefined, false);
      } catch {
        record("unconfirmed", "unconfirmed", undefined, undefined, false);
        this.publish({ submissionError: NOTIFICATION_STRINGS.submitError });
      }
    })();
  }
}

const desktopNotifications = new DesktopNotifications({
  read: () => invoke("desktop_notifications_get"),
  save: (enabled, sound) =>
    invoke("desktop_notifications_set", { enabled, sound }),
  submit: (kind, sequence, targetKey, rendererNonce) =>
    invoke("desktop_notification_submit", {
      kind,
      sequence,
      targetKey,
      rendererNonce,
    }),
  background: () =>
    typeof document !== "undefined" &&
    (document.hidden || !document.hasFocus()),
});

/** Call once at applyChannelEvent entry, before changing the thread state. */
export const observeDesktopNotification = desktopNotifications.observe;
export const observeBrowserDesktopNotification =
  desktopNotifications.observeBrowserRequest;
export const desktopNotificationDiagnostic = desktopNotifications.diagnostic;

export function useDesktopNotifications() {
  const state = useSyncExternalStore(
    desktopNotifications.subscribe,
    desktopNotifications.snapshot,
    desktopNotifications.snapshot,
  );
  useEffect(() => {
    void desktopNotifications.load(true);
    const refresh = () => {
      void desktopNotifications.load(true);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return {
    ...state,
    setEnabled: desktopNotifications.setEnabled,
    setSound: desktopNotifications.setSound,
    retry: () => desktopNotifications.load(true),
  };
}
