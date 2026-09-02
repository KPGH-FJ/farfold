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
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const primaryControl = useRef<HTMLButtonElement>(null);
  const expire = useRef(onExpire);
  const respond = useRef(onRespond);

  useEffect(() => {
    expire.current = onExpire;
    respond.current = onRespond;
  }, [onExpire, onRespond]);

  useEffect(() => {
    setDraft(request.method === "editor" ? (request.prefill ?? "") : "");
    window.setTimeout(() => {
      const requestedControl =
        request.method === "editor"
          ? editor.current
          : request.method === "input"
            ? input.current
            : primaryControl.current;
      const fallback = dialog.current?.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
      );
      (requestedControl ?? fallback)?.focus();
    }, 0);
  }, [request]);

  useEffect(() => {
    if (!request.timeout) return;
    const timer = window.setTimeout(() => expire.current(), request.timeout);
    return () => window.clearTimeout(timer);
  }, [request.id, request.timeout]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        respond.current({ cancelled: true });
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function submitText() {
    onRespond({ value: draft });
  }

  return (
    <div className="extension-overlay" role="presentation">
      <section
        ref={dialog}
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
            {request.options?.map((option, index) => (
              <button
                ref={index === 0 ? primaryControl : undefined}
                key={option}
                onClick={() => onRespond({ value: option })}
              >
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
            <button
              ref={primaryControl}
              onClick={() => onRespond({ confirmed: false })}
            >
              否
            </button>
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
