import { invoke } from "@tauri-apps/api/core";
import type { OfficialReadOnlyCheck } from "./preparation";
import type { ConfigOptionView } from "./session_types";

export interface OfficialReadOnlyTarget {
  agentId: string;
  checkId: string;
  cwd: string;
  model: string;
  reasoningEffort: string;
}

export interface OfficialReadOnlyReport {
  accountPresent: boolean;
  workspaceReported: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

function currentChoice(options: readonly ConfigOptionView[], id: string) {
  if (!id.trim()) return undefined;
  const matching = options.filter((option) => option.id === id);
  if (matching.length !== 1) return undefined;
  const value = matching[0].currentValue;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function officialReadOnlyTarget(
  agentId: string,
  cwd: string,
  check: OfficialReadOnlyCheck | undefined,
  options: readonly ConfigOptionView[],
): OfficialReadOnlyTarget | null {
  if (
    typeof check?.id !== "string" ||
    !check.id.trim() ||
    typeof check.modelOptionId !== "string" ||
    typeof check.reasoningOptionId !== "string" ||
    check.modelOptionId === check.reasoningOptionId ||
    !cwd
  )
    return null;
  const model = currentChoice(options, check.modelOptionId);
  const reasoningEffort = currentChoice(options, check.reasoningOptionId);
  return model && reasoningEffort
    ? { agentId, checkId: check.id, cwd, model, reasoningEffort }
    : null;
}

export async function runOfficialReadOnlyCheck(
  target: OfficialReadOnlyTarget,
  requestId: string,
): Promise<OfficialReadOnlyReport> {
  const report = await invoke<OfficialReadOnlyReport>(
    "agent_official_readonly_check",
    { ...target, requestId },
  );
  if (
    typeof report?.accountPresent !== "boolean" ||
    typeof report.workspaceReported !== "boolean" ||
    typeof report.provider !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(report.provider) ||
    report.model !== target.model ||
    report.reasoningEffort !== target.reasoningEffort
  )
    throw { code: "unconfirmed" };
  return report;
}

export const cancelOfficialReadOnlyCheck = (
  agentId: string,
  requestId: string,
) =>
  invoke<void>("agent_official_readonly_check_cancel", { agentId, requestId });
