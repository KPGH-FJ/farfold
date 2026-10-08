import React, { useEffect, useRef } from "react";
import { FileText } from "@phosphor-icons/react";
import { Button } from "./ui";
import { fileReadEvent } from "./conversation-content-state.js";

export function FilePreviewReview({ task, file, onTaskChange }) {
  if (!task || !file) return null;
  return (
    <details className="cr-file-review">
      <summary>文件预览场景 · 演示</summary>
      <div>
        <Button
          onClick={() => onTaskChange(fileReadEvent(task, file.path, "failed"))}
        >
          模拟本文件读取失败
        </Button>
        <Button
          onClick={() => onTaskChange(fileReadEvent(task, file.path, "ready"))}
        >
          恢复示例内容
        </Button>
        <Button
          onClick={() =>
            onTaskChange({
              artifactVersions: {
                ...task.artifactVersions,
                [file.path]: !task.artifactVersions?.[file.path],
              },
            })
          }
        >
          {task.artifactVersions?.[file.path]
            ? "返回第一版示例"
            : "展示第二版文件"}
        </Button>
      </div>
    </details>
  );
}

export default function FilePreviewState({ task, file, onTaskChange, onBack }) {
  const phase = task?.filePreviewStates?.[file.path];
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (phase !== "loading") return;
    const id = task.id,
      path = file.path;
    const timer = setTimeout(() => {
      if (
        latest.current.id === id &&
        latest.current.filePreviewStates?.[path] === "loading"
      )
        onTaskChange(fileReadEvent(latest.current, path, "ready"));
    }, 800);
    return () => clearTimeout(timer);
  }, [phase, file.path, task?.id]);
  if (!phase || phase === "ready") return null;
  return (
    <section className="cr-file-state" role="status" aria-label="文件预览状态">
      <FileText size={26} />
      <strong>
        {phase === "loading" ? "正在重新读取文件…" : "暂时无法显示这份文件"}
      </strong>
      <p>{file.path}</p>
      <p>
        {phase === "loading"
          ? "其他文件仍可选择，返回不会丢失对话和意见草稿。"
          : "本次示例读取未完成。对话和已有文件意见已保留。"}
      </p>
      <div>
        <Button
          disabled={phase === "loading"}
          primary
          onClick={() =>
            onTaskChange(fileReadEvent(task, file.path, "loading"))
          }
        >
          重新读取文件
        </Button>
        <Button onClick={onBack}>返回文件列表</Button>
      </div>
      <small>演示状态 · 未读取真实文件</small>
    </section>
  );
}
