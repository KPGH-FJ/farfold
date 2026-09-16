import { useEffect, useRef, useState } from "react";
import { Key } from "@phosphor-icons/react";
import type { AuthPrompt } from "../runtime/capabilities";

export function ProviderAuthPrompt({
  prompt,
  disabled = false,
  onReply,
}: {
  prompt: { id: string; value: AuthPrompt };
  disabled?: boolean;
  onReply: (value: string) => void | Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    setAnswer("");
    setFailed(false);
    input.current?.focus();
  }, [prompt.id]);
  async function reply(value: string) {
    if (pending.current || disabled || !value.trim()) return;
    pending.current = true;
    setSending(true);
    setAnswer("");
    setFailed(false);
    try {
      await onReply(value);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSending(false);
    }
  }
  const locked = disabled || sending;
  return (
    <>
      {prompt.value.type === "select" ? (
        <div className="auth-options">
          <p>{prompt.value.message}</p>
          {prompt.value.options.map((option) => (
            <button
              key={option.id}
              disabled={locked}
              onClick={() => void reply(option.id)}
            >
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <form
          className="auth-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            void reply(answer);
          }}
        >
          <label>
            <span>{prompt.value.message}</span>
            <div>
              <Key size={16} />
              <input
                ref={input}
                type={prompt.value.type === "text" ? "text" : "password"}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                disabled={locked}
                placeholder={prompt.value.placeholder || "输入 Pi 请求的信息"}
                autoComplete="off"
                spellCheck={false}
                maxLength={65536}
              />
            </div>
          </label>
          <button type="submit" disabled={locked || !answer.trim()}>
            继续
          </button>
        </form>
      )}
      {failed && (
        <p className="auth-error" role="alert">
          认证回复未确认，请核对当前登录状态。
        </p>
      )}
    </>
  );
}
