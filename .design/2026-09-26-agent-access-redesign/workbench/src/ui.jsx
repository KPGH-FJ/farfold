import React, { useEffect, useRef } from "react";
import {
  X,
  Check,
  CircleNotch,
  WarningCircle,
  Robot,
} from "@phosphor-icons/react";
export function Button({
  children,
  primary = false,
  kind = "",
  className = "",
  ...props
}) {
  return (
    <button
      type="button"
      className={`btn ${primary ? "primary" : ""} ${kind} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
export function Badge({ children, tone = "" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
const AGENT_ICONS = { Codex: "codex", OpenCode: "opencode", Pi: "pi-color" };
export function AgentIcon({ name = "Codex", size = 22 }) {
  const asset = AGENT_ICONS[name];
  return asset ? (
    <img
      className="agent-icon"
      width={size}
      height={size}
      src={"/assets/" + asset + ".svg"}
      alt={name}
    />
  ) : (
    <Robot className="agent-icon" size={size} aria-label={name} />
  );
}
export function PageHeading({ eyebrow, title, description, children }) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="heading-actions">{children}</div>
    </header>
  );
}
export function Empty({ icon: Icon, title, children, action }) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={32} />}
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Notice({ tone = "", title, children, action }) {
  return (
    <div className={`notice ${tone}`}>
      <WarningCircle size={19} />
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}
export function Modal({
  title,
  titleContent,
  children,
  onClose,
  wide = false,
  footer,
}) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    const el = ref.current;
    el?.focus();
    const key = (e) => {
      // Block navigation shortcuts without swallowing child form handlers.
      const navigationShortcut =
        (e.metaKey || e.ctrlKey) &&
        ["k", "n", ","].includes(e.key.toLowerCase());
      if (navigationShortcut || e.key === "Escape" || e.key === "Tab")
        e.stopPropagation();
      if (navigationShortcut) e.preventDefault();
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key === "Tab") {
        const a = [
          ...el.querySelectorAll(
            "button,input,textarea,select,a[href],summary,[tabindex]",
          ),
        ].filter(
          (x) =>
            !x.disabled &&
            x.tabIndex >= 0 &&
            x.getClientRects().length > 0 &&
            !x.closest('[inert],[aria-hidden="true"]'),
        );
        if (!a.length) {
          e.preventDefault();
          return;
        }
        if (
          e.shiftKey &&
          (document.activeElement === a[0] || document.activeElement === el)
        ) {
          e.preventDefault();
          a.at(-1).focus();
        } else if (!e.shiftKey && document.activeElement === a.at(-1)) {
          e.preventDefault();
          a[0].focus();
        }
      }
    };
    el?.addEventListener("keydown", key);
    return () => {
      el?.removeEventListener("keydown", key);
      if (prev?.isConnected && prev.getClientRects().length) prev.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{titleContent || title}</h2>
          <Button aria-label="关闭" kind="icon" onClick={onClose}>
            <X size={20} />
          </Button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  );
}
export function Toggle({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Tabs({ items, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          aria-selected={value === x.id}
          className={value === x.id ? "active" : ""}
          onClick={() => onChange(x.id)}
        >
          {x.label}
          {x.count !== undefined && <span>{x.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function Status({ value }) {
  const labels = {
    running: "进行中",
    approval: "等你确认",
    question: "等你回答",
    recovery: "需要恢复",
    unknown: "结果未知",
    done: "已完成",
    stopped: "已停止",
    failed: "未通过",
    draft: "草稿",
  };
  return (
    <span className={`status ${value}${value === "failed" ? " recovery" : ""}`}>
      {value === "running" ? (
        <CircleNotch size={14} className="spin" />
      ) : value === "done" ? (
        <Check size={14} />
      ) : (
        <span className="status-dot" />
      )}
      {labels[value] || value}
    </span>
  );
}
