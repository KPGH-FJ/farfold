import { STRINGS } from "./strings";
import { ERROR_STRINGS } from "./error_strings";

/** Exact app-owned directory error only, never an arbitrary diagnostic or path. */
export function workDirectoryError(reason: unknown): string | undefined {
  return String(reason).replace(/^Error: /, "") ===
    "AGENT_WORK_DIRECTORY_UNAVAILABLE"
    ? ERROR_STRINGS.workDirectoryUnavailable
    : undefined;
}

/** Exact app-owned opening codes only; unknown objects and diagnostics stay private. */
export function agentOpenError(reason: unknown): string | undefined {
  const code =
    typeof reason === "string"
      ? reason.replace(/^Error: /, "")
      : reason instanceof Error &&
          reason.name === "Error" &&
          typeof reason.message === "string"
        ? reason.message
        : undefined;
  switch (code) {
    case "AGENT_INITIALIZE_FAILED":
      return ERROR_STRINGS.agentInitializeFailed;
    case "AGENT_INITIALIZE_TIMEOUT":
      return ERROR_STRINGS.agentInitializeTimeout;
    case "AGENT_CONNECTION_ENDED":
      return ERROR_STRINGS.agentConnectionEnded;
    case "AGENT_START_FAILED":
      return ERROR_STRINGS.agentStartFailed;
    case "AGENT_OPEN_TIMEOUT":
      return ERROR_STRINGS.agentOpenTimeout;
    case "AGENT_OPEN_CLOSED":
      return ERROR_STRINGS.agentOpenClosed;
    case "AGENT_OPEN_WAIT_CANCELLED":
      return ERROR_STRINGS.agentOpenWaitCancelled;
  }
}

/** Only present short app-authored, user-language errors; never raw transport diagnostics. */
export function uiError(reason: unknown, fallback: string): string {
  const raw = String(reason);
  const directory = workDirectoryError(reason);
  if (directory) return directory;
  // Only exact app-authored codes are eligible; payloads and decorated codes
  // remain behind the caller's fallback rather than exposing transport text.
  const opening = agentOpenError(reason);
  if (opening) return opening;
  if (
    /AGENT_(?:INITIALIZE_|CONNECTION_|START_|OPEN_|WORK_DIRECTORY_)/i.test(raw)
  )
    return fallback;
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
