import React, { useEffect, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  FileArrowDown,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button, Modal } from "./ui";
import { exportPreviewOutcome } from "./conversation-export.js";

export default function ConversationExportDialog({ snapshot, mode, onClose }) {
  const [attempt, setAttempt] = useState(1);
  const [state, setState] = useState({ phase: "preparing" });
  const [downloadUrl, setDownloadUrl] = useState("");
  useEffect(() => {
    setState({ phase: "preparing" });
    const timer = setTimeout(
      () => setState(exportPreviewOutcome(snapshot, mode, attempt)),
      850,
    );
    return () => clearTimeout(timer);
  }, [snapshot, mode, attempt]);
  useEffect(() => {
    if (state.phase !== "ready" || !snapshot) return;
    const url = URL.createObjectURL(
      new Blob([snapshot.markdown], { type: "text/markdown;charset=utf-8" }),
    );
    setDownloadUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setDownloadUrl("");
    };
  }, [state.phase, snapshot]);
  const preparing = state.phase === "preparing";
  return (
    <Modal
      title="导出 Markdown"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{preparing ? "取消准备" : "关闭"}</Button>
          {state.phase === "failed" && (
            <Button primary onClick={() => setAttempt((value) => value + 1)}>
              重试准备
            </Button>
          )}
          {state.phase === "ready" && downloadUrl && (
            <a
              className="btn primary cr-export-download"
              href={downloadUrl}
              download={snapshot.filename}
            >
              <FileArrowDown size={17} />
              下载 Markdown
            </a>
          )}
        </>
      }
    >
      <section className="cr-export-state" role="status" aria-live="polite">
        {preparing ? (
          <CircleNotch className="spin" size={28} />
        ) : state.phase === "ready" ? (
          <CheckCircle size={28} />
        ) : (
          <WarningCircle size={28} />
        )}
        <h3>
          {preparing
            ? "正在准备导出文件…"
            : state.phase === "ready"
              ? "文件已准备好"
              : "导出未完成"}
        </h3>
        {state.phase === "failed" ? (
          <p>{state.reason}</p>
        ) : (
          <p>{snapshot?.filename || "正在整理当前示例消息"}</p>
        )}
        {state.phase === "ready" && (
          <p>
            {snapshot.messageCount} 条已展示示例消息 ·
            点击下载后，由浏览器保存本地文件。
          </p>
        )}
      </section>
      <p className="cr-context">
        仅导出打开此窗口时已展示的原型消息。不会读取隐藏历史、发送草稿、调用
        Agent 或锁住其他对话操作。
      </p>
    </Modal>
  );
}
