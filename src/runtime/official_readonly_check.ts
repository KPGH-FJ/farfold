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
  const matching = options.filter((option) => option.id === id);
  return matching.length === 1 ? matching[0].currentValue : undefined;
}

function selectedTarget(
  agentId: string,
  cwd: string,
  check: OfficialReadOnlyCheck | undefined,
  read: (id: string) => unknown,
): OfficialReadOnlyTarget | null {
  if (
    typeof check?.id !== "string" ||
    !check.id.trim() ||
    typeof check.modelOptionId !== "string" ||
    !check.modelOptionId.trim() ||
    typeof check.reasoningOptionId !== "string" ||
    !check.reasoningOptionId.trim() ||
    check.modelOptionId === check.reasoningOptionId ||
    !cwd
  )
    return null;
  const model = read(check.modelOptionId);
  const reasoningEffort = read(check.reasoningOptionId);
  return typeof model === "string" &&
    model.trim() &&
    typeof reasoningEffort === "string" &&
    reasoningEffort.trim()
    ? { agentId, checkId: check.id, cwd, model, reasoningEffort }
    : null;
}

export function officialReadOnlyTarget(
  agentId: string,
  cwd: string,
  check: OfficialReadOnlyCheck | undefined,
  options: readonly ConfigOptionView[],
) {
  return selectedTarget(agentId, cwd, check, (id) =>
    currentChoice(options, id),
  );
}

export function savedOfficialReadOnlyTarget(
  agentId: string,
  cwd: string,
  check: OfficialReadOnlyCheck | undefined,
  config: Readonly<Record<string, unknown>>,
) {
  return selectedTarget(agentId, cwd, check, (id) =>
    Object.hasOwn(config, id) ? config[id] : undefined,
  );
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
