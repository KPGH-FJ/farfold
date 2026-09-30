import React, { useState } from "react";
import { Modal, Button } from "./ui";
export default function AttachmentRecoveryDialog({
  files,
  onClose,
  onConfirm,
}) {
  const entries = files.map((file) =>
    typeof file === "string" ? { id: file, label: file } : file,
  );
  const [kept, setKept] = useState(() => entries.map((file) => file.id));
  return (
    <Modal
      title="核对恢复的附件"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>稍后处理</Button>
          <Button primary onClick={() => onConfirm(kept)}>
            保留所选附件
          </Button>
        </>
      }
    >
      <p>
        原型只保留示例附件记录。以下模拟真实产品重新检查文件可读性；无法找到的附件需要移除或重新选择。
      </p>
      <div className="attachment-review-list">
        {entries.map((file) => (
          <label key={file.id}>
            <input
              type="checkbox"
              checked={kept.includes(file.id)}
              onChange={(event) =>
                setKept(
                  event.target.checked
                    ? [...kept, file.id]
                    : kept.filter((item) => item !== file.id),
                )
              }
            />
            {file.label}
          </label>
        ))}
      </div>
    </Modal>
  );
}
