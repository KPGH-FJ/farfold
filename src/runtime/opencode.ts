import { readActiveHostTurns } from "./host-turns";
import type { RuntimeIdentity, RuntimeSessionBinding } from "./adapter";

export type OpenCodeEnvelope = {
  generation: number;
  kind: "sse" | "protocol_error" | "transport_error" | "acp";
  payload: unknown;
  runtime: RuntimeIdentity;
};

export interface HostTurnSubmission {
  turnId: string;
  acceptedAt: number;
}

export type OpenCodeTurnSubmission =
  | { outcome: "accepted"; submission: HostTurnSubmission }
  | { outcome: "unknown"; detail: string };

export interface OpenCodeRecoveryTarget {
  turnId: string;
  farfoldSessionId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
}

export async function openCodeRecoveryTarget(
  sessionId: string,
  generation: number | undefined,
  installationId: string,
): Promise<OpenCodeRecoveryTarget | null> {
  const turn = (await readActiveHostTurns()).find(
    (turn) =>
      turn.runtimeProductId === "opencode" &&
      turn.installationId === installationId &&
      turn.farfoldSessionId === sessionId &&
      (generation === undefined || turn.runtimeGeneration === generation),
  );
  return turn
    ? {
        turnId: turn.turnId,
        farfoldSessionId: turn.farfoldSessionId,
        nativeSessionId: turn.nativeSessionId,
        runtimeGeneration: turn.runtimeGeneration,
      }
    : null;
}

export interface OpenCodeSessionBindingRecord extends RuntimeSessionBinding {
  farfoldSessionId: string;
  runtimeBuildId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
