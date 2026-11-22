export interface OpenInput {
  inquirySignal?: AbortSignal;
  inquiryCurrent?: () => boolean;
  /** Read-only preparation cannot authorize an Agent operation. */
  inquiryPermissions?: "ask" | "cancel";
  agentId: string;
  cwd: string;
  nativeSessionId?: string;
  openPurpose?: "conversation" | "preparation" | "codex-official-check";
  configOptions?: Record<string, unknown> | null;
  fresh?: boolean;
  /** Allow an abandoned ordinary draft to withdraw only its waiting open. */
  cancelWaitingDraft?: true;
  /** Separate preparation drafts from the ordinary unsent conversation. Memory only. */
  draftScope?: string;
  service?: import("./credentials").ServiceSelection | null;
  serviceRevision?: string;
}

export function draftGroup(input: OpenInput): string {
  return `${input.agentId}|${input.cwd}|${JSON.stringify(input.service ?? null)}|${input.serviceRevision ?? ""}|${input.draftScope ?? ""}${input.openPurpose === "codex-official-check" ? "|official-check" : ""}`;
}
