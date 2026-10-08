import { STRINGS } from "./strings";
/** Only present short app-authored, user-language errors; never raw transport diagnostics. */
export function uiError(reason: unknown, fallback: string): string {
  const raw = String(reason);
  // Only exact app-authored codes are eligible; payloads and decorated codes
  // remain behind the caller's fallback rather than exposing transport text.
  switch (raw.replace(/^Error: /, "")) {
    case "AGENT_INITIALIZE_FAILED":
      return "连接检查未完成，请检查程序或启动设置后重试";
    case "AGENT_INITIALIZE_TIMEOUT":
      return "等待连接检查超时，请稍后重试";
    case "AGENT_CONNECTION_ENDED":
      return "连接在检查完成前结束，请检查程序后重试";
    case "AGENT_START_FAILED":
      return "程序未能启动，请检查程序文件和资料文件夹后重试";
  }
  if (/AGENT_(?:INITIALIZE_|CONNECTION_|START_)/i.test(raw)) return fallback;
  if (raw.replace(/^Error:\s*/, "") === "AUTH_REQUIRED")
    return STRINGS.access.authRequired;
  const text = raw.replace(/^Error:\s*/, "");
  return /^[\u3400-\u9fff]/.test(text) &&
    text.length <= 180 &&
    !/[\r\n]|runtime|host|acp|原生|绑定|代次|投影|占用|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i.test(
      text,
    )
    ? text
    : fallback;
}

/** User-language reason plus the original text kept for collapsed details. */
export interface UiNotice {
  message: string;
  /** Raw error text/code shown only inside expandable technical details. */
  detail?: string;
}

/**
 * Normalize an unknown error for the shared error surface: the primary layer
 * gets the `uiError` conclusion, while the original text stays collapsed.
 */
export function toUiNotice(reason: unknown, fallback: string): UiNotice {
  const message = uiError(reason, fallback);
  const raw = String(reason).replace(/^Error:\s*/, "");
  return raw && raw !== message ? { message, detail: raw } : { message };
}
