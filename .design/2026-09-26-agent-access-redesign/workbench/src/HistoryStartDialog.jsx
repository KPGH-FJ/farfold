import React from "react";
import { Button, Modal } from "./ui";
import {
  historyStartCandidate,
  historySourceIssue,
  currentSourceSummary,
} from "./history-start-state.js";
function Source({ title, choice, folder }) {
  return (
    <section className="history-start-summary">
      <strong>{title}</strong>
      <dl>
        <dt>Agent / 模型</dt>
        <dd>
          {choice.agent || "未选择"} · {choice.model || "未提供"}
        </dd>
        <dt>服务来源</dt>
        <dd>{choice.source || "未提供"}</dd>
        {choice.serviceSnapshot && (
          <>
            <dt>地址 / 格式</dt>
            <dd>
              {choice.serviceSnapshot.endpoint || "未提供"} ·{" "}
              {choice.serviceSnapshot.format || "未提供"}
            </dd>
          </>
        )}
        <dt>工作位置</dt>
        <dd>{folder || "发送前需选择"}</dd>
      </dl>
    </section>
  );
}
export default function HistoryStartDialog({
  request,
  current,
  agents,
  services,
  onClose,
  onApply,
  error,
}) {
  const next = historyStartCandidate(
    request.task,
    request.message,
    request.folder,
  );
  const issue = historySourceIssue(next.choice, agents, services, next.folder);
  const source = currentSourceSummary(next.choice, services);
  return (
    <Modal
      title={request.message ? "从这条消息开始新对话" : "用相同设置再开一段"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消并保留原处</Button>
          <Button
            primary
            onClick={() =>
              onApply({
                ...next,
                choice: {
                  ...next.choice,
                  requiresSourceSelection: Boolean(issue),
                },
              })
            }
          >
            {issue ? "保留内容并重新选择" : "保留原草稿并进入新对话"}
          </Button>
        </>
      }
    >
      <p>
        原对话和消息保持不变。这里只准备新草稿，不复制完整历史，也不会自动发送。
      </p>
      <Source title="新草稿将沿用" choice={next.choice} folder={next.folder} />
      {issue && (
        <div role="alert" className="history-start-alert">
          <strong>{issue}</strong>
          <p>
            当前来源：
            {source.service
              ? `${source.service.name} · ${source.service.endpoint || "地址未提供"} · ${source.service.format}`
              : "当前没有可核对的 API 服务"}
            。原设置不会自动改成新来源；发送前必须重新选择。
          </p>
        </div>
      )}
      {(current.text || current.files.length > 0) && (
        <>
          <Source
            title="现有未发草稿将另行保留"
            choice={current.choice}
            folder={current.folder}
          />
          <blockquote>
            {current.text || `${current.files.length} 个附件`}
          </blockquote>
          <p>文字、附件和设置会保存到“保留的草稿”，可随时找回。</p>
        </>
      )}
      {request.message && (
        <section>
          <strong>带入这条消息</strong>
          <blockquote className="history-start-preview">
            {next.text || "仅附件"}
          </blockquote>
          <p>{next.files.length} 个附件；这只是原消息的内容副本。</p>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
export function SavedDrafts({ items, onRestore }) {
  if (!items.length) return null;
  return (
    <details className="history-saved-drafts">
      <summary>保留的草稿 · {items.length}</summary>
      <p>恢复时会把当前未发内容另行保留，不覆盖它。</p>
      {items.map((item) => (
        <article key={item.id}>
          <span>
            {item.title}
            <small>
              {item.draft.choice.agent || "未选 Agent"} ·{" "}
              {item.draft.folder || "未选位置"} · {item.draft.files.length}{" "}
              个附件
            </small>
          </span>
          <Button onClick={() => onRestore(item)}>恢复这份草稿</Button>
        </article>
      ))}
    </details>
  );
}
