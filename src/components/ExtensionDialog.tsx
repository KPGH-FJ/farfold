import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import type { ExtensionDialogRequest } from "../runtime/pi";

interface ExtensionDialogProps {
  request: ExtensionDialogRequest;
  onRespond: (response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }) => void;
  onExpire: () => void;
}

export function ExtensionDialog({
  request,
  onRespond,
  onExpire,
}: ExtensionDialogProps) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const expire = useRef(onExpire);

  useEffect(() => {
    expire.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    setDraft(request.method === "editor" ? (request.prefill ?? "") : "");
    window.setTimeout(
      () => (request.method === "editor" ? editor : input).current?.focus(),
      0,
    );
  }, [request]);

  useEffect(() => {
    if (!request.timeout) return;
    const timer = window.setTimeout(() => expire.current(), request.timeout);
    return () => window.clearTimeout(timer);
  }, [request.id, request.timeout]);

  useEffect(() => {
    function cancel(event: KeyboardEvent) {
      if (event.key === "Escape") onRespond({ cancelled: true });
    }
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [onRespond]);

  function submitText() {
    onRespond({ value: draft });
  }

  return (
    <div className="extension-overlay" role="presentation">
      <section
        className="extension-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-dialog-title"
      >
        <button
          className="extension-dialog-close"
          onClick={() => onRespond({ cancelled: true })}
          aria-label="取消"
        >
          <X size={15} />
        </button>
        <span className="extension-dialog-eyebrow">Pi Extension</span>
        <h2 id="extension-dialog-title">{request.title}</h2>
        {request.message && <p>{request.message}</p>}

        {request.method === "select" && (
          <div className="extension-options">
            {request.options?.map((option) => (
              <button key={option} onClick={() => onRespond({ value: option })}>
                {option}
              </button>
            ))}
          </div>
        )}

        {(request.method === "input" || request.method === "editor") && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitText();
            }}
          >
            {request.method === "editor" ? (
              <textarea
                ref={editor}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={8}
              />
            ) : (
              <input
                ref={input}
                value={draft}
                placeholder={request.placeholder}
                onChange={(event) => setDraft(event.target.value)}
              />
            )}
            <div className="extension-dialog-actions">
              <button
                type="button"
                onClick={() => onRespond({ cancelled: true })}
              >
                取消
              </button>
              <button className="primary" type="submit">
                提交
              </button>
            </div>
          </form>
        )}

        {request.method === "confirm" && (
          <div className="extension-dialog-actions">
            <button onClick={() => onRespond({ confirmed: false })}>否</button>
            <button
              className="primary"
              onClick={() => onRespond({ confirmed: true })}
            >
              是
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
