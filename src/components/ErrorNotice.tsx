import type { ReactNode } from "react";
import { ERROR_STRINGS as E } from "../runtime/error_strings";

/**
 * Shared readable error surface (PRODUCT.md §6, plan W3-3): one short
 * user-language reason, an optional next-step action (children), and the
 * original error text/code kept inside expandable 技术详情. Long or
 * defensive text must never occupy the primary layer.
 */
export function ErrorNotice({
  title,
  message,
  detail,
  className,
  role = "alert",
  children,
}: {
  /** Short conclusion label, e.g. 会话打开失败. */
  title?: string;
  /** User-language reason (already normalized via uiError). */
  message?: string;
  /** Original text/code; rendered only inside collapsed 技术详情. */
  detail?: string | null;
  /** Override the container class for banner-style surfaces. */
  className?: string;
  role?: "alert" | "status";
  children?: ReactNode;
}) {
  const extra = detail && detail !== message ? detail : null;
  return (
    <div className={className ?? "auth-note error-notice"} role={role}>
      {title && <span className="b-tag">{title}</span>}
      {message && <span className="error-msg">{message}</span>}
      {children}
      {extra && (
        <details className="error-detail">
          <summary>{E.technicalDetails}</summary>
          <pre>{extra}</pre>
        </details>
      )}
    </div>
  );
}
