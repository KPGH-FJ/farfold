import { useState } from "react";
import type { CodexNativeTurn } from "../runtime/codex-session";
import { decisionLabel, type CodexReply } from "../runtime/codex-interaction";
import type { CodexInteractionView } from "../runtime/codex-workspace-view";
import { useNativeInteractionReply } from "../runtime/use-native-interaction-reply";

export function CodexInteractionPanel({
  interaction,
  turns,
  enabled,
  onReply,
}: {
  interaction: CodexInteractionView;
  turns: CodexNativeTurn[];
  enabled: boolean;
  onReply: (reply: CodexReply) => Promise<void>;
}) {
  const { pending, request, key: scopeKey } = interaction;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const reply = useNativeInteractionReply(scopeKey);
  const fileChange = request.method === "item/fileChange/requestApproval";
  const question = request.method === "item/tool/requestUserInput";
  const params = request.nativeRequest.params;
  const item = turns
    .find((t) => t.id === request.turnId)
    ?.items.find((i) => i.id === request.itemId);
  const disabled =
    !enabled ||
    !!interaction.unavailableReason ||
    reply.busy ||
    pending.state === "responding" ||
    sent;
  const changes =
    interaction.fileChanges ??
    (item?.type === "fileChange" ? item.changes : undefined);
  const readable = fileChange
    ? Array.isArray(changes)
    : typeof params.command === "string" ||
      !!params.networkApprovalContext ||
      !!params.additionalPermissions;
  async function respond(value: CodexReply) {
    if (disabled) return;
    await reply.respond(
      () => onReply(value),
      () => setSent(true),
      () => undefined,
    );
  }
  return (
    <section
      className="codex-interaction runtime-permission"
      aria-label={question ? "Codex 提问" : "Codex 审批"}
    >
      <h3>
        {question
          ? "Codex 等待你的回答"
          : fileChange
            ? "Codex 请求修改文件"
            : "Codex 请求执行命令或访问网络"}
      </h3>
      {interaction.unavailableReason && (
        <p role="status">{interaction.unavailableReason}</p>
      )}
      {typeof params.reason === "string" && <p>{params.reason}</p>}
      {typeof params.command === "string" && <pre>{params.command}</pre>}
      {typeof params.cwd === "string" && <p>执行目录：{params.cwd}</p>}
      {fileChange &&
        (readable ? (
          <pre>{JSON.stringify(changes, null, 2)}</pre>
        ) : (
          <p>尚未收到原生修改详情，允许操作暂不可用。</p>
        ))}
      {!question && !fileChange && !readable && (
        <p>原生操作详情不完整，允许操作暂不可用。</p>
      )}
      {question ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void respond({
              type: "answers",
              answers: Object.fromEntries(
                request.questions.map((q) => [q.id, [answers[q.id] ?? ""]]),
              ),
            });
          }}
        >
          {request.questions.map((q) => (
            <fieldset key={q.id} disabled={disabled}>
              <legend>
                {q.header}：{q.question}
              </legend>
              {q.options?.map((o) => (
                <label key={o.label} className="codex-question-option">
                  <input
                    type="radio"
                    name={q.id}
                    checked={answers[q.id] === o.label}
                    onChange={() =>
                      setAnswers((a) => ({ ...a, [q.id]: o.label }))
                    }
                  />
                  <span>
                    {o.label}
                    <small>{o.description}</small>
                  </span>
                </label>
              ))}
              {(q.isOther || !q.options?.length) && (
                <label>
                  你的回答
                  <input
                    type={q.isSecret ? "password" : "text"}
                    autoComplete="off"
                    value={answers[q.id] ?? ""}
                    onChange={(e) =>
                      setAnswers((a) => ({ ...a, [q.id]: e.target.value }))
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          <button
            type="submit"
            disabled={
              disabled || request.questions.some((q) => !answers[q.id]?.trim())
            }
          >
            提交回答
          </button>
        </form>
      ) : (
        <div className="codex-approval-choices">
          {request.decisions.map((decision, index) => (
            <div key={index}>
              {typeof decision === "object" && (
                <pre>{JSON.stringify(decision, null, 2)}</pre>
              )}
              <button
                disabled={
                  disabled ||
                  (!readable && decision !== "decline" && decision !== "cancel")
                }
                onClick={() => void respond({ type: "decision", decision })}
              >
                {decisionLabel(decision, fileChange)}
              </button>
            </div>
          ))}
        </div>
      )}
      {(sent || pending.state === "responding") && (
        <p role="status">回复已发送，等待 Codex 处理确认。</p>
      )}
      {reply.error && <p role="alert">{reply.error}</p>}
      <details>
        <summary>查看原生请求详情</summary>
        <pre>{JSON.stringify(request.nativeRequest, null, 2)}</pre>
      </details>
    </section>
  );
}
