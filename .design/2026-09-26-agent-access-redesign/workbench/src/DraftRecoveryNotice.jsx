import React from "react";
import { Button } from "./ui";
export default function DraftRecoveryNotice({
  restored,
  files,
  attachmentsNeedReview,
  onConfirmAttachments,
  storageIssue,
  onDismiss,
}) {
  if (!restored && !storageIssue) return null;
  return (
    <section
      className="draft-recovery-notice"
      aria-label="草稿恢复"
      role="status"
    >
      <div>
        <strong>
          {storageIssue ? "这份草稿暂时无法保存" : "已找回上次未发送的内容"}
        </strong>
        <p>
          {storageIssue
            ? "本次编辑仍在页面里。请先复制需要保留的内容，恢复存储后再重启。"
            : "Agent、模型、来源和工作位置一并保留。请确认后再发送。"}
        </p>
        {attachmentsNeedReview && (
          <p>附件：{files.join("、")}。重启后需要确认它们仍可用。</p>
        )}
      </div>
      {attachmentsNeedReview ? (
        <Button onClick={onConfirmAttachments}>核对附件</Button>
      ) : (
        !storageIssue && (
          <Button kind="ghost" onClick={onDismiss}>
            知道了
          </Button>
        )
      )}
    </section>
  );
}
