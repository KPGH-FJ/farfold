import { invoke } from "@tauri-apps/api/core";
export interface CodexTurnTarget {
  farfoldSessionId: string;
  nativeSessionId: string;
  generation: number;
}
export type CodexSubmission =
  | { outcome: "accepted"; hostTurnId: string; nativeTurnId: string }
  | { outcome: "unknown"; detail: string };
export function submitCodexTurn(
  target: CodexTurnTarget,
  text: string,
  mode: "default" | "plan",
): Promise<CodexSubmission> {
  return invoke("host_codex_turn_submit", { input: { ...target, text, mode } });
}
export function interruptCodexTurn(
  target: CodexTurnTarget,
  expectedTurnId: string,
): Promise<void> {
  return invoke("host_codex_turn_interrupt", {
    input: { ...target, expectedTurnId },
  });
}

export function steerCodexTurn(
  target: CodexTurnTarget,
  expectedTurnId: string,
  text: string,
): Promise<CodexSubmission> {
  return invoke("host_codex_turn_steer", {
    input: { ...target, expectedTurnId, text },
  });
}
