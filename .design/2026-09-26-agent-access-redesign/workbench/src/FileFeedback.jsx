import React from "react";
import { ChatCircleText } from "@phosphor-icons/react";
import { Button, Badge } from "./ui";
import {
  feedbackKey,
  updateFeedback,
  takeFeedback,
} from "./conversation-policy.js";
import "./execution-review.css";

export default function FileFeedback({ task, file, onTaskChange, toast }) {
  if (!task || !file) return null;
  const key = feedbackKey(file);
  const note = task.feedbackDrafts?.[key] || { text: "", line: "" };
  const previous = Object.entries(task.feedbackDrafts || {}).filter(
    ([entryKey, entry]) =>
      entryKey !== key && entry.path === file.path && entry.text?.trim(),
  );
  const add = (entryKey) => {
    const patch = takeFeedback(task, entryKey);
    if (!patch) return;
    onTaskChange(patch);
    toast?.("意见已加入这条对话的输入框，尚未发送");
  };
  return (
    <section className="file-feedback" aria-label="文件意见草稿">
      <details open={Boolean(note.text || previous.length)}>
        <summary>
          <ChatCircleText size={16} /> 写下文件意见{" "}
          {note.text && <Badge>草稿已保留</Badge>}
        </summary>
        <div className="file-feedback-body">
          <p>
            {file.path} · {file.versionLabel || "当前内容"} ·
            意见对应你正在查看的版本
          </p>
          <label>
            行位置（可选）
            <input
              aria-label="意见行位置"
              value={note.line}
              placeholder="例如 8–12"
              onChange={(event) =>
                onTaskChange(
                  updateFeedback(task, file, { line: event.target.value }),
                )
              }
            />
          </label>
          <textarea
            aria-label="文件意见"
            rows={3}
            value={note.text}
            placeholder="写下这份内容中需要调整的地方…"
            onChange={(event) =>
              onTaskChange(
                updateFeedback(task, file, { text: event.target.value }),
              )
            }
          />
          <div className="file-feedback-actions">
            <small>
              意见只带回原对话。切文件或关闭后保留，加入输入框后再由你发送。
            </small>
            <Button disabled={!note.text.trim()} onClick={() => add(key)}>
              加入输入框
            </Button>
          </div>
          {previous.map(([entryKey, item]) => (
            <div key={entryKey} className="file-feedback-previous">
              <strong>之前版本的意见已保留</strong>
              <small>
                {item.versionLabel} {item.line ? `· 第 ${item.line} 行` : ""} ·
                仍对应当时的位置
              </small>
              <p>{item.text}</p>
              <Button onClick={() => add(entryKey)}>
                将这条意见加入输入框
              </Button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
