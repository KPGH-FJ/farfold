import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpScope } from "./codex-acp-contract";
import {
  sameCodexAcpScope,
  type CodexAcpSelection,
} from "./codex-acp-workspace";
import type { CodexAdmissionCommand } from "./codex-acp-admission";

export type CodexSessionCommand =
  | {
      action: "start";
      workingCopyId: string;
      choice: Omit<
        Extract<CodexAdmissionCommand, { action: "select" }>,
        "action"
      >;
    }
  | { action: "open"; farfoldSessionId: string };
export interface CodexSessionReceipt {
  scope: CodexAcpScope;
  farfoldSessionId: string;
  workingCopyId: string;
  nativeThreadId: string;
  nativeTreeId: string;
  selection: CodexAcpSelection;
}
const invalid = () => new Error("会话身份未确认；不会自动重试或替换原会话");
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
const native = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const fields = [
  "catalogModelId",
  "nativeModel",
  "provider",
  "reasoningEffort",
] as const;

/** Typed contract only. Ordinary capabilities and the independent Host gate remain closed. */
export async function requestCodexAcpSession(
  scope: CodexAcpScope,
  command: CodexSessionCommand,
): Promise<CodexSessionReceipt> {
  if (command.action === "start") {
    const c = command.choice;
    if (
      !id(command.workingCopyId) ||
      !c ||
      !sameCodexAcpScope(c.observationScope, scope) ||
      !Number.isSafeInteger(c.epoch) ||
      c.epoch < 1 ||
      !/^[0-9a-f]{64}$/i.test(c.catalogHash) ||
      !c.selection ||
      !fields.every((f) => id(c.selection[f]))
    )
      throw invalid();
  } else if (command.action !== "open" || !id(command.farfoldSessionId))
    throw invalid();
  let raw: { kind: string; snapshot: CodexSessionReceipt };
  try {
    raw = await invoke("host_codex_acp_operation", {
      input: { action: "session", scope, command },
    });
  } catch {
    throw invalid();
  }
  const r = raw?.snapshot;
  if (
    raw?.kind !== "session" ||
    !r ||
    !sameCodexAcpScope(r.scope, scope) ||
    !id(r.farfoldSessionId) ||
    !id(r.workingCopyId) ||
    !native(r.nativeThreadId) ||
    !native(r.nativeTreeId) ||
    !r.selection ||
    !fields.every((f) => id(r.selection[f])) ||
    Object.keys(r).some(
      (k) =>
        ![
          "scope",
          "farfoldSessionId",
          "workingCopyId",
          "nativeThreadId",
          "nativeTreeId",
          "selection",
        ].includes(k),
    ) ||
    (command.action === "start"
      ? r.workingCopyId !== command.workingCopyId ||
        fields.some((f) => r.selection[f] !== command.choice.selection[f])
      : r.farfoldSessionId !== command.farfoldSessionId)
  )
    throw invalid();
  return {
    scope: { ...scope },
    farfoldSessionId: r.farfoldSessionId,
    workingCopyId: r.workingCopyId,
    nativeThreadId: r.nativeThreadId,
    nativeTreeId: r.nativeTreeId,
    selection: {
      catalogModelId: r.selection.catalogModelId,
      nativeModel: r.selection.nativeModel,
      provider: r.selection.provider,
      reasoningEffort: r.selection.reasoningEffort,
    },
  };
}
