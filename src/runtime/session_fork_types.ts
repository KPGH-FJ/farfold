import type { OpenResult } from "./session_open_types";
import type { HistoryForkPoint } from "./history_fork_point";

/** Current connection declaration; never inferred from an Agent name. */
export interface SessionOperations {
  forkCurrentContext: boolean;
  forkHistoricalPoint?: boolean;
  closeAfterUnconfirmedStop?: true;
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
  historyPoint?: HistoryForkPoint;
  ownerEnded?: true;
  settled?: true;
  reason?: string;
  /** One actual local delivery failure, retained only in memory. */
  deliveryError?: unknown;
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
  historyPoint?: HistoryForkPoint | null;
}

export function sessionOperations(value: unknown): SessionOperations {
  return {
    ...(!!value &&
      typeof value === "object" &&
      "closeAfterUnconfirmedStop" in value &&
      value.closeAfterUnconfirmedStop === true && {
        closeAfterUnconfirmedStop: true as const,
      }),
    forkHistoricalPoint:
      !!value &&
      typeof value === "object" &&
      "forkHistoricalPoint" in value &&
      value.forkHistoricalPoint === true,
    forkCurrentContext:
      !!value &&
      typeof value === "object" &&
      "forkCurrentContext" in value &&
      value.forkCurrentContext === true,
  };
}
