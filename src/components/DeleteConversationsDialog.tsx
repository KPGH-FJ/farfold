import type { RefObject } from "react";
import { LIBRARY } from "../runtime/library_strings";
import { DangerConfirmDialog } from "./DangerConfirm";
import "../library-dialogs.css";

/**
 * W3-9 删除确认：明确删除对象、保留对象与 Agent 侧处理结果。
 * 调用方负责执行删除；确认后标题写清楚范围（单条或批量/清空归档）。
 */
export function DeleteConversationsDialog({
  title,
  hint,
  busy,
  error,
  onDelete,
  onClose,
  returnFocusRef,
}: {
  /** Dialog heading, e.g. `删除 3 段对话` or `清空已归档`. */
  title: string;
  /** Scope and what stays; deletion is irreversible. */
  hint: string;
  busy: boolean;
  error: string | null;
  onDelete: () => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <DangerConfirmDialog
      title={title}
      busy={busy}
      error={error}
      confirmLabel={LIBRARY.deleteConfirm}
      onConfirm={onDelete}
      cancelLabel={LIBRARY.cancel}
      onCancel={onClose}
      returnFocusRef={returnFocusRef}
    >
      <p>{hint}</p>
      <p>{LIBRARY.deleteAgentNote}</p>
    </DangerConfirmDialog>
  );
}
