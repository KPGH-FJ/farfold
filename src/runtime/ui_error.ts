/** Only present short app-authored, user-language errors; never raw transport diagnostics. */
export function uiError(reason: unknown, fallback: string): string {
  const text = String(reason).replace(/^Error:\s*/, "");
  return /^[\u3400-\u9fff]/.test(text) &&
    text.length <= 180 &&
    !/[\r\n]|runtime|host|acp|原生|绑定|代次|投影|占用|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i.test(
      text,
    )
    ? text
    : fallback;
}
