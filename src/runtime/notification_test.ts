import { invoke } from "@tauri-apps/api/core";

export const NOTIFICATION_TEST = {
  title: "测试桌面提醒",
  description: "发送一条测试提醒，点击后回到这里。不会更改对话或任务状态。",
  send: "发送测试提醒",
  sending: "正在发送测试提醒…",
  again: "再发一条测试提醒",
  soundOn: "沿用已保存的声音选择；是否响铃还取决于系统设置。",
  soundOff: "当前声音已关闭，这条测试提醒不会请求响铃。",
  unavailable: "请先完成提醒设置的读取或保存，再发送测试提醒。",
  submitted: "已交给系统，请查看是否收到。点击提醒可回到这里。",
  suppressed: "本次测试提醒未发送，提醒设置或窗口状态可能已变化。",
  permission: "系统尚未允许通知。请在提醒设置中检查许可后再测试。",
  preference: "提醒设置未能读取，请重新检查设置后再测试。",
  system: "系统通知暂不可用，请重新检查后再测试。",
  failed: "本次测试提醒未发送，请重新检查后再测试。",
  unknown:
    "尚不能确认系统是否收到这条测试提醒，没有自动重发。再次点击会发送一条新的测试提醒。",
} as const;

export type NotificationTestState = {
  phase: "idle" | "pending" | "submitted" | "suppressed" | "failed" | "unknown";
  message: string | null;
};
interface Attempt {
  rendererNonce: string;
  sequence: number;
}
export interface NotificationTestPort {
  submit(attempt: Attempt): Promise<unknown>;
  withdraw(attempt: Attempt): Promise<unknown>;
}
const nativePort: NotificationTestPort = {
  submit: (attempt) => invoke("desktop_notification_test", { ...attempt }),
  withdraw: (attempt) =>
    invoke("desktop_notification_withdraw", { ...attempt }),
};
function nonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
function failure(reason: unknown): NotificationTestState {
  const code = typeof reason === "string" ? reason : "";
  const known: Record<string, string> = {
    NOTIFICATION_TEST_PERMISSION_REQUIRED: NOTIFICATION_TEST.permission,
    NOTIFICATION_TEST_PREFERENCE_UNAVAILABLE: NOTIFICATION_TEST.preference,
    NOTIFICATION_TEST_SYSTEM_UNAVAILABLE: NOTIFICATION_TEST.system,
    NOTIFICATION_TEST_NOT_SUBMITTED: NOTIFICATION_TEST.failed,
    NOTIFICATION_TEST_MAIN_ONLY: NOTIFICATION_TEST.failed,
  };
  return Object.hasOwn(known, code)
    ? { phase: "failed", message: known[code] }
    : { phase: "unknown", message: NOTIFICATION_TEST.unknown };
}

/** One explicit action, with the existing notification ticket and withdrawal.
 * No thread observer, unread state, permission request, or automatic retry. */
export class NotificationTest {
  state: NotificationTestState = { phase: "idle", message: null };
  private alive = true;
  private sequence = 0;
  private active: Attempt | null = null;
  private readonly rendererNonce = nonce();
  constructor(
    private readonly changed: (state: NotificationTestState) => void,
    private readonly port: NotificationTestPort = nativePort,
  ) {}
  private publish(state: NotificationTestState) {
    if (!this.alive) return;
    this.state = state;
    this.changed(state);
  }
  async send(allowed: boolean) {
    if (!this.alive || this.active) return;
    if (!allowed) {
      this.publish({ phase: "failed", message: NOTIFICATION_TEST.unavailable });
      return;
    }
    const attempt = {
      rendererNonce: this.rendererNonce,
      sequence: ++this.sequence,
    };
    this.active = attempt;
    this.publish({ phase: "pending", message: null });
    try {
      const result = await this.port.submit(attempt);
      if (!this.alive || this.active !== attempt) return;
      this.publish(
        result === "submitted"
          ? { phase: "submitted", message: NOTIFICATION_TEST.submitted }
          : result === "suppressed"
            ? { phase: "suppressed", message: NOTIFICATION_TEST.suppressed }
            : { phase: "unknown", message: NOTIFICATION_TEST.unknown },
      );
    } catch (reason) {
      if (this.alive && this.active === attempt) this.publish(failure(reason));
    } finally {
      if (this.active === attempt) this.active = null;
    }
  }
  release() {
    if (!this.alive) return;
    this.alive = false;
    const attempt = this.active;
    this.active = null;
    if (attempt) void this.port.withdraw(attempt).catch(() => {});
  }
}
