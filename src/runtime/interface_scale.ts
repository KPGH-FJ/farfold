import { invoke } from "@tauri-apps/api/core";

export const INTERFACE_SCALES = [100, 110, 125, 150] as const;
export type InterfaceScale = (typeof INTERFACE_SCALES)[number];
export const INTERFACE_SCALE_STRINGS = {
  label: "界面大小",
  hint: "放大文字和操作按钮，重开后保持。",
  loading: "正在读取界面大小…",
  saving: "正在保存界面大小…",
  loadFailed: "未能读取界面大小，暂时使用默认大小。",
  saveFailed: "未能保存界面大小，仍保留原来的大小。",
  applyFailed: "界面大小已保存，但当前显示未能更新。请重新应用。",
  applyRetry: "重新应用",
  retry: "重新读取",
  larger: "放大界面",
  smaller: "缩小界面",
  reset: "恢复默认大小",
};
export function isInterfaceScale(value: unknown): value is InterfaceScale {
  return INTERFACE_SCALES.some((scale) => scale === value);
}
export type InterfaceScaleState = {
  value: InterfaceScale;
  ready: boolean;
  saving: boolean;
  error: string | null;
  errorKind: "load" | "save" | "apply" | null;
};

/** One owner for the saved preference. Reads and writes never overlap, and a
 * released view cannot apply a late receipt to a later view. */
export class InterfaceScalePreference {
  private state: InterfaceScaleState = {
    value: 100,
    ready: false,
    saving: false,
    error: null,
    errorKind: null,
  };
  private listeners = new Set<() => void>();
  private reading: Promise<void> | null = null;
  private alive = true;
  constructor(
    private readonly apply: (value: InterfaceScale) => Promise<void>,
    private readonly read: () => Promise<unknown> = () =>
      invoke("settings_get", { key: "interfaceScale" }),
    private readonly write: (value: InterfaceScale) => Promise<unknown> = (
      value,
    ) => invoke("settings_set", { key: "interfaceScale", value }),
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<InterfaceScaleState>) {
    if (!this.alive) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  load = (): Promise<void> => {
    if (!this.alive || this.state.saving) return Promise.resolve();
    if (this.reading) return this.reading;
    this.update({ ready: false, error: null, errorKind: null });
    this.reading = Promise.resolve()
      .then(this.read)
      .then(async (saved) => {
        if (!this.alive) return;
        const value = isInterfaceScale(saved) ? saved : 100;
        this.update({ value, ready: true, saving: true });
        await this.applySaved();
      })
      .catch(() => {
        this.update({
          error: INTERFACE_SCALE_STRINGS.loadFailed,
          errorKind: "load",
        });
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  };
  private applySaved = async (): Promise<void> => {
    if (!this.alive) return;
    this.update({ saving: true, error: null, errorKind: null });
    try {
      await this.apply(this.state.value);
    } catch {
      this.update({
        error: INTERFACE_SCALE_STRINGS.applyFailed,
        errorKind: "apply",
      });
    } finally {
      this.update({ saving: false });
    }
  };
  retryApply = (): Promise<void> => {
    if (
      !this.alive ||
      !this.state.ready ||
      this.state.saving ||
      this.state.errorKind !== "apply"
    )
      return Promise.resolve();
    return this.applySaved();
  };
  save = async (value: InterfaceScale): Promise<void> => {
    if (
      !this.alive ||
      !this.state.ready ||
      this.state.saving ||
      !isInterfaceScale(value) ||
      value === this.state.value
    )
      return;
    this.update({ saving: true, error: null, errorKind: null });
    try {
      await this.write(value);
    } catch {
      this.update({
        error: INTERFACE_SCALE_STRINGS.saveFailed,
        errorKind: "save",
        saving: false,
      });
      return;
    }
    if (!this.alive) return;
    this.update({ value });
    await this.applySaved();
  };
  release() {
    this.alive = false;
    this.listeners.clear();
  }
}
