import { invoke } from "@tauri-apps/api/core";
import type { CodexTurnTarget } from "./codex-turn";
import type { HostPendingInteraction } from "./host-shadow";
export interface CodexQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
}
export interface CodexInteraction {
  key: string;
  threadId: string;
  turnId: string;
  itemId: string;
  method: string;
  decisions: unknown[];
  questions: CodexQuestion[];
  nativeRequest: {
    id: string | number;
    method: string;
    params: Record<string, unknown>;
  };
}
export type CodexReply =
  | { type: "decision"; decision: unknown }
  | { type: "answers"; answers: Record<string, string[]> };
export function replyCodexInteraction(
  target: CodexTurnTarget,
  interactionId: string,
  reply: CodexReply,
): Promise<void> {
  return invoke("host_codex_interaction_reply", {
    input: { ...target, interactionId, reply },
  });
}
export function codexInteractions(
  pending: HostPendingInteraction[],
  installationId: string,
  generation: number,
  threadId: string,
): HostPendingInteraction[] {
  return pending.filter(
    (p) =>
      p.kind === "codex_native" &&
      p.runtime.productId === "codex" &&
      p.runtime.adapterId === "codex-app-server" &&
      p.runtime.installationId === installationId &&
      p.runtimeGeneration === generation &&
      p.nativeSessionId === threadId &&
      p.codex?.threadId === threadId &&
      p.codex.key === p.interactionId,
  );
}
export function decisionLabel(value: unknown, fileChange: boolean): string {
  if (typeof value === "string")
    return (
      (
        {
          accept: "允许本次",
          acceptForSession: fileChange
            ? "允许本次及本会话内相同文件的后续修改"
            : "允许本次并记住本会话内的同类审批",
          decline: "拒绝，继续任务",
          cancel: "拒绝并中断任务",
        } as Record<string, string>
      )[value] ?? "未支持的原生选项"
    );
  if (
    value &&
    typeof value === "object" &&
    "acceptWithExecpolicyAmendment" in value
  )
    return "允许并保存此命令规则";
  if (
    value &&
    typeof value === "object" &&
    "applyNetworkPolicyAmendment" in value
  )
    return "保存此网络规则";
  return "未支持的原生选项";
}
