import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpScope } from "./codex-acp-contract";
import { sameCodexAcpScope } from "./codex-acp-workspace";

export type CodexAcpTurnCommand =
  | { action: "send"; farfoldSessionId: string; text: string }
  | {
      action: "interrupt";
      farfoldSessionId: string;
      hostTurnId: string;
      nativeTurnId: string;
    };
export interface CodexAcpTurnReceipt {
  scope: CodexAcpScope;
  farfoldSessionId: string;
  hostTurnId: string;
  nativeTurnId: string;
  outcome: "started" | "interrupt_accepted";
}
const invalid = () =>
  new Error(
    "任务回执未确认；保留原轮次，不会自动重试。Stop 接受不代表任务已结束。",
  );
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
const native = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
function exact(v: unknown, fields: string[]): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length === fields.length &&
    fields.every((k) => Object.hasOwn(v, k))
  );
}

/** Typed closed contract only. Host consumes events independently; no client drain. */
export async function requestCodexAcpTurn(
  scope: CodexAcpScope,
  command: CodexAcpTurnCommand,
): Promise<CodexAcpTurnReceipt> {
  const original = { ...scope };
  const request = { ...command };
  if (
    !sameCodexAcpScope(original, original) ||
    original.runtimeProductId !== "codex" ||
    original.adapterId !== "codex-acp-stdio-v1" ||
    !Number.isSafeInteger(original.generation) ||
    original.generation < 1 ||
    Object.entries(original).some(([k, v]) => k !== "generation" && !id(v)) ||
    !id(request.farfoldSessionId)
  )
    throw invalid();
  if (request.action === "send") {
    if (
      !exact(request, ["action", "farfoldSessionId", "text"]) ||
      typeof request.text !== "string" ||
      !request.text.trim() ||
      new TextEncoder().encode(request.text).length > 65536
    )
      throw invalid();
  } else if (
    request.action !== "interrupt" ||
    !exact(request, [
      "action",
      "farfoldSessionId",
      "hostTurnId",
      "nativeTurnId",
    ]) ||
    !id(request.hostTurnId) ||
    !native(request.nativeTurnId)
  )
    throw invalid();
  let raw: unknown;
  try {
    raw = await invoke("host_codex_acp_operation", {
      input: { action: "turn", scope: original, command: request },
    });
  } catch {
    throw invalid();
  }
  if (
    !exact(raw, ["kind", "snapshot"]) ||
    raw.kind !== "turn" ||
    !exact(raw.snapshot, [
      "scope",
      "farfoldSessionId",
      "hostTurnId",
      "nativeTurnId",
      "outcome",
    ])
  )
    throw invalid();
  const r = raw.snapshot;
  if (
    !exact(r.scope, Object.keys(original)) ||
    !sameCodexAcpScope(r.scope as unknown as CodexAcpScope, original) ||
    r.farfoldSessionId !== request.farfoldSessionId ||
    !id(r.hostTurnId) ||
    !native(r.nativeTurnId) ||
    r.outcome !==
      (request.action === "send" ? "started" : "interrupt_accepted") ||
    (request.action === "interrupt" &&
      (r.hostTurnId !== request.hostTurnId ||
        r.nativeTurnId !== request.nativeTurnId))
  )
    throw invalid();
  return {
    scope: original,
    farfoldSessionId: request.farfoldSessionId,
    hostTurnId: r.hostTurnId,
    nativeTurnId: r.nativeTurnId,
    outcome: request.action === "send" ? "started" : "interrupt_accepted",
  };
}
