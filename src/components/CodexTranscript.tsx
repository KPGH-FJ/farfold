import { MessageContent } from "./MessageContent";
import type { ProjectFileSession } from "../runtime/project-file-reference";
import { object, type CodexConversation } from "../runtime/codex-conversation";
import type { AcpTranscript } from "../runtime/codex-acp-transcript";
const text = (v: unknown) => (typeof v === "string" ? v : "");
export function CodexTranscript({
  conversation,
  session,
  summary,
  acp,
}: {
  conversation: CodexConversation;
  session: ProjectFileSession | null;
  summary?: string | null;
  acp?: AcpTranscript | null;
}) {
  return (
    <div className="message-list">
      {summary && <p role="status">{summary}</p>}
      {(acp ? acp.incomplete : conversation.truncated) && (
        <p role="alert">当前事件或显示内容不完整，不能视为完整历史。</p>
      )}
      {(acp ? acp.turns : conversation.turns).map((turn) => (
        <section
          className="codex-turn"
          key={text(object(turn)?.nativeTurnId ?? object(turn)?.id)}
          aria-label={`Codex 轮次 ${text(object(turn)?.nativeTurnId ?? object(turn)?.id)}`}
        >
          {acp && (
            <p className="message-label">
              {object(turn)?.source === "history"
                ? "原生有限历史 · Host Turn 身份未恢复"
                : "本连接事件观察"}{" "}
              ·{" "}
              {turn.status === "inProgress"
                ? "输出中"
                : turn.status === "completed"
                  ? "已观察原生完成"
                  : turn.status === "interrupted"
                    ? "已观察原生中断"
                    : turn.status === "failed"
                      ? "已观察原生失败"
                      : "状态未确认"}
            </p>
          )}
          {turn.items.map((item, index) => {
            const key = text(item.id) || `unknown-${index}`;
            const detail = object(item)!;
            if (item.type === "userMessage" || item.type === "agentMessage") {
              const body =
                item.type === "agentMessage"
                  ? text(detail.text)
                  : Array.isArray(detail.content)
                    ? detail.content
                        .map((v) => text(object(v)?.text))
                        .filter(Boolean)
                        .join("\n")
                    : "";
              return (
                <article
                  key={key}
                  className={`message ${item.type === "userMessage" ? "user" : "assistant"}`}
                >
                  {item.type === "agentMessage" && (
                    <span className="assistant-mark">F</span>
                  )}
                  <div>
                    <p className="message-label">
                      {item.type === "userMessage" ? "你" : "Farfold · Codex"}
                    </p>
                    {item.type === "agentMessage" ? (
                      <MessageContent text={body} session={session} />
                    ) : (
                      <p className="message-text">{body}</p>
                    )}
                  </div>
                </article>
              );
            }
            if (acp && item.type === "reasoning")
              return (
                <details key={key} className="codex-native-item">
                  <summary>推理摘要与内容（有限投影）</summary>
                  <pre>
                    {[detail.summary, detail.content]
                      .flatMap((v) => (Array.isArray(v) ? v.map(text) : []))
                      .join("\n")}
                  </pre>
                </details>
              );
            return (
              <details key={key} className="codex-native-item">
                <summary>
                  {item.type === "commandExecution"
                    ? "命令"
                    : item.type === "fileChange"
                      ? "文件修改"
                      : text(item.type) || "未识别原生条目"}{" "}
                  · {text(detail.status) || "原生详情"}
                </summary>
                {acp ? (
                  <p>仅恢复条目身份与状态；命令全文、输出或差异未提供。</p>
                ) : (
                  <>
                    {detail.command ? <pre>{text(detail.command)}</pre> : null}
                    {detail.aggregatedOutput ? (
                      <pre>{text(detail.aggregatedOutput)}</pre>
                    ) : null}
                    <pre>{JSON.stringify(item, null, 2)}</pre>
                  </>
                )}
              </details>
            );
          })}
          {turn.status === "failed" && (
            <p role="alert">
              原生任务失败：
              {text(object(object(turn)?.error)?.message) ||
                "请查看原生错误详情"}
            </p>
          )}
          {turn.status === "interrupted" && <p>原生轮次已中断</p>}
        </section>
      ))}
      {!acp && conversation.diagnostics.length > 0 && (
        <details>
          <summary>事件诊断（{conversation.diagnostics.length}）</summary>
          {conversation.diagnostics.map((d, i) => (
            <p key={i}>{d}</p>
          ))}
        </details>
      )}
    </div>
  );
}
