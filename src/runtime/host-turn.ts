import { invoke } from "@tauri-apps/api/core";

/**
 * Runtime-neutral Host Turn commands. The backend resolves the Session
 * binding, selects the registered Runtime adapter, and reads the authoritative
 * Runtime generation itself — the client never supplies a generation.
 */
export type HostTurnOutcome =
  | { outcome: "accepted"; submission: { turnId: string; acceptedAt: number } }
  | { outcome: "cancelled" | "failed" | "unknown"; detail: string };

export interface HostTurnSubmitRequest {
  farfoldSessionId: string;
  nativeSessionId: string;
  text: string;
  /** OpenCode ACP managed-provider binding; rejected by other adapters. */
  providerConnectionId?: string;
  providerConfigVersionId?: string;
  runtimeProviderId?: string;
  runtimeModelId?: string;
}

export function hostTurnSubmit(
  input: HostTurnSubmitRequest,
): Promise<HostTurnOutcome> {
  return invoke("host_turn_submit", { input });
}

export function hostTurnAbort(input: {
  farfoldSessionId: string;
  nativeSessionId: string;
}): Promise<boolean> {
  return invoke("host_turn_abort", { input });
}
