import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { uiError } from "./ui_error";

export const DIAGNOSTIC_STRINGS = {
  title: "导出诊断",
  note: "本次遇到的问题（可选）",
  noteHint: "你填写的说明会按原样加入诊断文件，请不要填写密钥或私密内容。",
  notePlaceholder: "例如：恢复一个对话后无法继续发送。",
  scope:
    "应用自动收集的部分仅包含版本、限量连接记录、受限设置与统计，不包含对话正文、文件内容、密钥、命令内容或工作路径。",
  local: "只在本机保存，由你决定是否分享。不会自动上传。",
  preview: "预览诊断内容",
  previewing: "正在准备预览…",
  previewFailed: "暂时无法准备诊断预览，请重试。",
  review:
    "请检查下面将保存的完整内容。导出使用这份预览，不会临时添加新的记录。",
  export: "确认并导出",
  exporting: "正在导出…",
  exportFailed: "诊断导出失败，请重试或重新准备预览。",
  refresh: "重新准备预览",
  edit: "返回修改说明",
  done: "诊断文件已保存在本机",
  contents: "查看包含内容",
  background: "关闭面板不会取消当前操作，可以再打开查看结果。",
  close: "关闭",
} as const;
export interface DiagnosticPreview {
  previewId: string;
  generatedAt: string;
  entries: { name: string; text: string }[];
}
export interface DiagnosticState {
  note: string;
  phase: "edit" | "loading" | "preview" | "exporting" | "done";
  preview: DiagnosticPreview | null;
  path: string | null;
  error: string | null;
}
interface Ports {
  preview: (note: string) => Promise<DiagnosticPreview>;
  export: (previewId: string) => Promise<string>;
}
/** Only an in-memory review draft; actual collection and writing belong to the backend. */
export class DiagnosticsReview {
  private state: DiagnosticState = {
    note: "",
    phase: "edit",
    preview: null,
    path: null,
    error: null,
  };
  private revision = 0;
  private listeners = new Set<() => void>();
  constructor(
    private readonly ports: Ports = {
      preview: (note) => invoke("diagnostics_preview", { note }),
      export: (previewId) => invoke("export_diagnostics", { previewId }),
    },
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<DiagnosticState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((fn) => fn());
  }
  setNote(note: string) {
    if (this.state.phase === "exporting") return;
    ++this.revision;
    this.publish({
      note,
      phase: "edit",
      preview: null,
      path: null,
      error: null,
    });
  }
  edit = () => {
    if (this.state.phase !== "exporting") {
      ++this.revision;
      this.publish({ phase: "edit", error: null });
    }
  };
  showPreview = () => {
    if (this.state.preview && this.state.phase === "done")
      this.publish({ phase: "preview" });
  };
  async prepare() {
    if (["loading", "exporting"].includes(this.state.phase)) return;
    const ticket = ++this.revision;
    const note = this.state.note;
    this.publish({ phase: "loading", error: null, preview: null, path: null });
    try {
      const preview = await this.ports.preview(note);
      if (ticket === this.revision) this.publish({ phase: "preview", preview });
    } catch (error) {
      if (ticket === this.revision)
        this.publish({
          phase: "edit",
          error: uiError(error, DIAGNOSTIC_STRINGS.previewFailed),
        });
    }
  }
  async export() {
    if (this.state.phase !== "preview" || !this.state.preview) return;
    const ticket = ++this.revision;
    const previewId = this.state.preview.previewId;
    this.publish({ phase: "exporting", error: null });
    try {
      const path = await this.ports.export(previewId);
      if (ticket === this.revision) this.publish({ phase: "done", path });
    } catch (error) {
      if (ticket === this.revision)
        this.publish({
          phase: "preview",
          error: uiError(error, DIAGNOSTIC_STRINGS.exportFailed),
        });
    }
  }
}
export const diagnosticsReview = new DiagnosticsReview();
export const useDiagnosticsReview = () =>
  useSyncExternalStore(
    diagnosticsReview.subscribe,
    diagnosticsReview.getSnapshot,
    diagnosticsReview.getSnapshot,
  );
