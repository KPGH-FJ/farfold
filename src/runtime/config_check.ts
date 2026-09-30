import type { ConfigOptionView, ThreadState } from "./session_types";
import { STRINGS } from "./strings";

export interface ConfigCheck {
  status: "ready" | "blocked" | "confirmation_required" | "record_failed";
  issues: {
    id?: string;
    category: "model" | "thought_level";
    reason: "changed" | "missing" | "unrecorded";
    expected: string | null;
    current: string | null;
  }[];
  current: unknown;
  protectedIds?: string[];
}
export function applyConfigCheck(s: ThreadState, check: ConfigCheck): void {
  s.configCheck = check;
  s.modelDrift = check.status !== "ready";
  if (s.modelDrift) s.queuePaused = "unavailable";
}
export function configCheckMessage(
  check: ConfigCheck | null,
  options: ConfigOptionView[] = [],
): string | null {
  if (!check || check.status === "ready") return null;
  if (check.status === "record_failed")
    return STRINGS.repair.configRecordFailed;
  const details = check.issues.map((issue) => {
    const name =
      options.find((option) => option.id === issue.id)?.name ??
      issue.id ??
      (issue.category === "model"
        ? STRINGS.repair.model
        : STRINGS.repair.thoughtLevel);
    if (issue.reason === "unrecorded")
      return `${STRINGS.repair.unrecordedConfig}${name}${issue.current === null ? "" : `（${STRINGS.repair.currentConfig}：${issue.current}）`}`;
    return `${name}：${issue.expected ?? STRINGS.repair.unknownModel} → ${issue.current ?? STRINGS.repair.unknownModel}`;
  });
  return `${details.join("；")}。${check.status === "confirmation_required" ? STRINGS.repair.confirmConfigHint : STRINGS.repair.configBlocked}`;
}
