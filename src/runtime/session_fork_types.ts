import type { OpenResult } from "./session_open_types";

/** Current connection declaration; never inferred from an Agent name. */
export interface SessionOperations {
  forkCurrentContext: boolean;
}

/** Memory-only delivery state, separate from the Agent's transcript. */
export interface ForkOperation {
  operationId: string;
  connectionId: string;
  parentSessionId: string;
  status: "pending" | "ready" | "created_unavailable" | "unknown" | "rejected";
  sourceReleased: boolean;
  childSessionId?: string;
  childKey?: string;
  indexed: boolean;
  ownerEnded?: true;
  settled?: true;
  reason?: string;
}

export interface ForkResult {
  status: "ready" | "created_unavailable" | "unknown" | "rejected";
  operationId: string;
  parentConnectionId: string;
  parentSessionId: string;
  cwd: string;
  childSessionId?: string | null;
  indexed: boolean;
  sourceReleased: boolean;
  session?: OpenResult | null;
  reason?: string | null;
}

export function sessionOperations(value: unknown): SessionOperations {
  return {
    forkCurrentContext:
      !!value &&
      typeof value === "object" &&
      "forkCurrentContext" in value &&
      value.forkCurrentContext === true,
  };
}
