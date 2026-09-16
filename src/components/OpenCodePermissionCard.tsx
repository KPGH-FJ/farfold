import { ShieldWarning } from "@phosphor-icons/react";
import { useState } from "react";
import type { OpenCodePermissionRequest } from "../runtime/opencode-conversation";

interface OpenCodePermissionCardProps {
  request: OpenCodePermissionRequest;
  busy: boolean;
  onRespond: (response: string | Record<string, string | string[]>) => void;
}

export function OpenCodePermissionCard({
  request,
  busy,
  onRespond,
}: OpenCodePermissionCardProps) {
  const question = request.requestKind === "question";
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  if (question && request.questionFields?.length) {
    const complete = request.questionFields.every(
      (field) =>
        (answers[field.id]?.length ?? 0) > 0 ||
        (field.customField &&
          String(answers[field.customField] ?? "").trim().length > 0),
    );
    return (
      <section
        className="runtime-permission opencode-question-form"
        aria-label="OpenCode 原生提问"
      >
        <ShieldWarning size={19} weight="fill" aria-hidden="true" />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (complete && !busy) onRespond(answers);
          }}
        >
          <p className="runtime-permission-eyebrow">OpenCode 原生提问</p>
          {request.questionFields.map((field) => (
            <fieldset key={field.id} disabled={busy}>
              <legend>{field.title}</legend>
              {field.options.map((option) => {
                const selected = field.multiple
                  ? (answers[field.id] as string[] | undefined)?.includes(
                      option.label,
                    )
                  : answers[field.id] === option.label;
                return (
                  <label key={option.label}>
                    <input
                      type={field.multiple ? "checkbox" : "radio"}
                      name={field.id}
                      checked={Boolean(selected)}
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          [field.id]: field.multiple
                            ? event.target.checked
                              ? [
                                  ...((current[field.id] as string[]) ?? []),
                                  option.label,
                                ]
                              : ((current[field.id] as string[]) ?? []).filter(
                                  (item) => item !== option.label,
                                )
                            : option.label,
                          ...(!field.multiple && field.customField
                            ? { [field.customField]: "" }
                            : {}),
                        }))
                      }
                    />
                    <span>
                      {option.label}
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </span>
                  </label>
                );
              })}
              {field.customField && (
                <label className="opencode-question-custom">
                  <span>其他回答</span>
                  <input
                    aria-label={`${field.title} 其他回答`}
                    value={String(answers[field.customField] ?? "")}
                    onChange={(event) =>
                      setAnswers((current) => {
                        const next = {
                          ...current,
                          [field.customField!]: event.target.value,
                        };
                        if (!field.multiple) delete next[field.id];
                        return next;
                      })
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          <div className="runtime-permission-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => onRespond("__decline")}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onRespond("__cancel")}
            >
              取消
            </button>
            <button
              type="submit"
              className="runtime-permission-primary"
              disabled={busy || !complete}
            >
              提交回答
            </button>
          </div>
        </form>
      </section>
    );
  }
  const detail = question
    ? ""
    : request.patterns.length
      ? request.patterns.join(" · ")
      : JSON.stringify(request.metadata);
  const primaryOptionId =
    request.options?.find((option) => option.kind === "accept")?.optionId ??
    request.options?.find((option) => option.kind === "allow_once")?.optionId ??
    request.options?.find((option) => option.kind === "allow_always")?.optionId;
  return (
    <section className="runtime-permission" aria-labelledby="permission-title">
      <ShieldWarning size={19} weight="fill" aria-hidden="true" />
      <div>
        <p className="runtime-permission-eyebrow">
          {question ? "OpenCode 原生提问" : "OpenCode 原生权限请求"}
        </p>
        <h3 id="permission-title">
          {question ? request.permission : `允许 ${request.permission}？`}
        </h3>
        {!question && <p>{detail || "OpenCode 未提供额外说明。"}</p>}
        <small>
          {question
            ? "此选择只回复 OpenCode 的原生提问，不会创建 LifeModel Proposal。"
            : "此选择只回复 OpenCode 的原生权限请求，不会创建 LifeModel Proposal。"}
        </small>
      </div>
      <div className="runtime-permission-actions">
        {request.options?.length ? (
          <>
            {request.options.map((option) => (
              <button
                key={option.optionId}
                className={
                  option.optionId === primaryOptionId
                    ? "runtime-permission-primary"
                    : undefined
                }
                disabled={busy}
                onClick={() => onRespond(option.optionId)}
              >
                {option.name}
              </button>
            ))}
            {question && (
              <>
                <button disabled={busy} onClick={() => onRespond("__decline")}>
                  拒绝
                </button>
                <button disabled={busy} onClick={() => onRespond("__cancel")}>
                  取消
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => onRespond("reject")}>
              拒绝
            </button>
            <button disabled={busy} onClick={() => onRespond("always")}>
              始终允许
            </button>
            <button
              className="runtime-permission-primary"
              disabled={busy}
              onClick={() => onRespond("once")}
            >
              仅本次允许
            </button>
          </>
        )}
      </div>
    </section>
  );
}
