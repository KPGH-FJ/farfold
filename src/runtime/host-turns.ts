import { invoke } from "@tauri-apps/api/core";

export interface ActiveHostTurn {
  turnId: string;
  farfoldSessionId: string;
  workingCopyId: string;
  runtimeProductId: string;
  installationId: string;
  runtimeConnectionId: string;
  nativeSessionId: string;
  runtimeGeneration: number;
  startedAt: number;
  runtimeObserved: boolean;
  outcomeUnknown: boolean;
  abortRequested: boolean;
}

export async function readActiveHostTurns(): Promise<ActiveHostTurn[]> {
  const snapshot = await invoke<{ activeTurns: ActiveHostTurn[] }>(
    "turn_coordinator_snapshot",
  );
  return snapshot.activeTurns;
}
