import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RuntimeStatus {
  running: boolean;
  projectPath: string | null;
  sessionDir: string | null;
  generation: number;
}

export type PiEnvelope =
  | { kind: "rpc"; payload: unknown }
  | { kind: "stderr"; payload: string }
  | { kind: "lifecycle"; payload: { state: string; detail?: unknown } }
  | { kind: "protocol_error"; payload: { line: string; error: string } };

export function runtimeStatus(): Promise<RuntimeStatus> {
  return invoke("pi_runtime_status");
}

export function startRuntime(
  projectPath: string | null,
): Promise<RuntimeStatus> {
  return invoke("pi_runtime_start", { projectPath });
}

export function stopRuntime(): Promise<RuntimeStatus> {
  return invoke("pi_runtime_stop");
}

export function sendRpc(command: Record<string, unknown>): Promise<void> {
  return invoke("pi_runtime_send", { command });
}

export function onPiEvent(
  handler: (event: PiEnvelope) => void,
): Promise<UnlistenFn> {
  return listen<PiEnvelope>("farfold://pi-event", (event) =>
    handler(event.payload),
  );
}
