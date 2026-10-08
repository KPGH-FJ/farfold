import React, { useState } from "react";
import { Button, Modal } from "./ui";
import { permissionOptions } from "./permission-state.js";

export default function ConversationPermissionRecovery({
  task,
  capability,
  permission,
}) {
  const [open, setOpen] = useState(false);
  const options = permissionOptions(capability);
  const [selected, setSelected] = useState(task.permissionValue || "");
  const [error, setError] = useState("");
  const pending = task.permissionChange?.phase === "pending";
  if (!task.permissionReconfirmRequired && !task.permissionChange) return null;
  return (
    <>
      <section className="cr-action-state" role="status">
        <div>
          <strong>{pending ? "正在确认权限" : "重新确认这条对话的权限"}</strong>
          <p>
            {pending
              ? "尚未收到确认，发送保持暂停。"
              : task.permissionReconfirmRequired
                ? "历史、草稿与待发消息已保留。恢复连接后，需要你重新选择权限；确认后再单独继续待发。"
                : "本次更改结果未确认，草稿与待发消息已保留。重新确认权限后，再单独继续待发。"}
          </p>
        </div>
        <Button
          disabled={pending}
          onClick={() => {
            setSelected(task.permissionValue || "");
            setOpen(true);
          }}
        >
          重新确认权限
        </Button>
      </section>
      {open && (
        <Modal
          title="重新确认权限"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setOpen(false)}>稍后处理</Button>
              <Button
                primary
                disabled={
                  pending ||
                  !options.some((option) => option.value === selected)
                }
                onClick={async () => {
                  setError("");
                  try {
                    await permission.reconfirm(selected);
                    setOpen(false);
                  } catch (err) {
                    setError(err.message);
                  }
                }}
              >
                确认本次权限
              </Button>
            </>
          }
        >
          <p>
            这会为本次恢复请求所选权限。只有收到相同返回值后才可继续；不会自动发送待发消息。
          </p>
          <label className="cr-demo-select">
            本次权限
            <select
              aria-label="重新确认的权限"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="" disabled>
                请选择权限
              </option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p>
            {options.find((option) => option.value === selected)?.description ||
              "当前 Agent 未提供可确认的权限选项，请先恢复连接。"}
          </p>
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
    </>
  );
}
