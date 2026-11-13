import { invoke } from "@tauri-apps/api/core";
import { LIBRARY } from "./library_strings";

type AgentDeletion = "deleted" | "unsupported" | "unconfirmed";
type DeletionTarget = { agentId: string; cwd: string; nativeSessionId: string };
export type SessionDeletionInput = Omit<DeletionTarget, "nativeSessionId"> & {
  id?: string;
  key?: string;
  nativeSessionId: string | null;
};

function agentOutcome(value: unknown): AgentDeletion | undefined {
  if (value === "deleted" || value === "unsupported" || value === "unconfirmed")
    return value;
}

export function agentDeletionNotice(value: AgentDeletion | null): string {
  if (value === "deleted") return LIBRARY.deleteAgentConfirmed;
  if (value === "unconfirmed") return LIBRARY.deleteAgentUnknown;
  return LIBRARY.deleteAgentNotRequested;
}

function localFailure(reason: unknown): Error {
  if (
    reason &&
    typeof reason === "object" &&
    "code" in reason &&
    "agent" in reason
  ) {
    const agent = agentOutcome(reason.agent);
    if (reason.code === "localNotRemoved" && (agent || reason.agent === null))
      return new Error(
        `${LIBRARY.deleteLocalNotRemoved}${agentDeletionNotice(agent ?? null)}`,
      );
    if (reason.code === "localRemovalUnknown" && agent)
      return new Error(
        `${LIBRARY.deleteLocalUnknown}${agentDeletionNotice(agent)}`,
      );
  }
  return new Error(LIBRARY.deleteLocalUnknown);
}

/** A resolved receipt confirms local removal. The Agent result is independent. */
export async function requestSessionDeletion(
  target: DeletionTarget,
  existing?: DeletionTarget,
  retireView?: (uncertain?: boolean) => void,
): Promise<AgentDeletion> {
  if (
    existing &&
    (existing.agentId !== target.agentId ||
      existing.cwd !== target.cwd ||
      existing.nativeSessionId !== target.nativeSessionId)
  )
    throw new Error(LIBRARY.deleteLocalNotRemoved);
  try {
    const receipt = agentOutcome(await invoke("session_delete", target));
    if (receipt) {
      retireView?.();
      return receipt;
    }
    throw new Error();
  } catch (reason) {
    // The backend owns close + delete on one captured connection. Do not infer
    // a close from a refusal; ambiguous delivery still retires the sending view.
    const known =
      reason &&
      typeof reason === "object" &&
      "code" in reason &&
      (reason.code === "localNotRemoved" ||
        reason.code === "localRemovalUnknown") &&
      "agent" in reason;
    if (known) {
      const remote = agentOutcome(reason.agent);
      if (
        ("connectionClosed" in reason &&
          reason.connectionClosed === true &&
          (remote || reason.agent === null)) ||
        remote === "deleted"
      )
        retireView?.();
      else if (remote === "unconfirmed") retireView?.(true);
    } else retireView?.(true);
    throw localFailure(reason);
  }
}

/** Hold the same identity through admission, local receipt and loaded cleanup. */
export class SessionDeletions {
  private readonly active = new Set<string>();
  has(key: string) {
    return this.active.has(key);
  }
  async run<T>(key: string, work: () => Promise<T>, release: () => void) {
    if (this.active.has(key))
      throw new Error(LIBRARY.deleteReasons.unconfirmed);
    this.active.add(key);
    try {
      return await work();
    } finally {
      this.active.delete(key);
      release();
    }
  }
}
