export interface OpenInput {
  inquirySignal?: AbortSignal;
  inquiryCurrent?: () => boolean;
  agentId: string;
  cwd: string;
  nativeSessionId?: string;
  configOptions?: Record<string, unknown> | null;
  fresh?: boolean;
  /** Separate preparation drafts from the ordinary unsent conversation. Memory only. */
  draftScope?: string;
  service?: import("./credentials").ServiceSelection | null;
  serviceRevision?: string;
}

export function draftGroup(input: OpenInput): string {
  return `${input.agentId}|${input.cwd}|${JSON.stringify(input.service ?? null)}|${input.serviceRevision ?? ""}|${input.draftScope ?? ""}`;
}
