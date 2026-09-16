import type { HostSessionBinding } from "./host-shadow";

export type SessionOpeningTarget =
  | { kind: "create"; projectPath: string }
  | {
      kind: "open";
      sessionId: string;
      session: Pick<
        HostSessionBinding,
        "farfoldSessionId" | "runtimeProductId" | "title" | "workingCopyPath"
      > | null;
    };

// A requested target is presentation intent, never an activated native binding.
// In particular, an unresolved target must not borrow the previous workspace.
export function describeSessionOpening(
  target: SessionOpeningTarget,
  runtimeProductId: string,
) {
  if (target.kind === "create") {
    return {
      sessionId: null,
      title: "新对话",
      projectPath: target.projectPath,
      action: "正在新建会话",
    };
  }
  const session = target.session;
  if (
    !session ||
    session.farfoldSessionId !== target.sessionId ||
    session.runtimeProductId !== runtimeProductId
  ) {
    return {
      sessionId: null,
      title: "打开会话",
      projectPath: null,
      action: "正在核对会话",
    };
  }
  return {
    sessionId: session.farfoldSessionId,
    title: session.title,
    projectPath: session.workingCopyPath,
    action: "正在打开会话",
  };
}

export function sessionOpeningError(
  target: SessionOpeningTarget,
  runtimeProductId: string,
  reason: unknown,
): string {
  const view = describeSessionOpening(target, runtimeProductId);
  const detail = reason instanceof Error ? reason.message : String(reason);
  const explanation =
    detail === "Farfold Session cannot be opened: native_locator_unavailable"
      ? "找不到原生会话记录。请恢复原记录后重试；此会话的绑定和草稿仍保留。（native_locator_unavailable）"
      : detail;
  return `${target.kind === "create" ? "新建" : "打开"}「${view.title}」失败：${explanation}`;
}
