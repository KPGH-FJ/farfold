import type { ConfigOptionView, ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import { configChangeBusy } from "./protected_config";
import { composerDrafts } from "./drafts";

import {
  ownsConfigurationPause,
  markConfigurationPause,
  forgetConfigurationPause,
} from "./configuration_pause";
export {
  ownsConfigurationPause,
  markConfigurationPause,
} from "./configuration_pause";
export function configurationInputBusy(s: ThreadState): boolean {
  return [`session:${s.key}`, `queue-edit:${s.key}`].some((key) => {
    const draft = composerDrafts.read(key);
    return Boolean(
      draft.sendPending || draft.queueEdit || draft.pendingConversation,
    );
  });
}
export function sameConfigurationSnapshot(
  left: unknown,
  right: unknown,
): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) =>
        sameConfigurationSnapshot(value, right[index]),
      )
    );
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameConfigurationSnapshot(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
/** Only an explicit, confirmed action may release its own empty configuration pause. */
export function releaseConfigurationPause(s: ThreadState): void {
  if (
    !ownsConfigurationPause(s) ||
    s.configCheck?.status !== "ready" ||
    s.modelDrift ||
    s.queued.length ||
    configurationInputBusy(s) ||
    configChangeBusy({ ...s, configuring: false }) ||
    (s.permissionConfigId && s.permissionState !== "ready")
  )
    return;
  forgetConfigurationPause(s);
  s.queuePaused = null;
}

export interface ConfigCheck {
  status: "ready" | "blocked" | "confirmation_required" | "record_failed";
  issues: {
    id?: string;
    category: "model" | "thought_level";
    reason: "changed" | "missing" | "unrecorded" | "unknown";
    expected: string | null;
    current: string | null;
  }[];
  current: unknown;
  protectedIds?: string[];
}
export function applyConfigCheck(s: ThreadState, check: ConfigCheck): void {
  s.configCheck = check;
  s.modelDrift = check.status !== "ready";
  ownsConfigurationPause(s);
  if (s.modelDrift && s.queuePaused === null) {
    s.queuePaused = "unavailable";
    markConfigurationPause(s);
  }
}
export function configCheckMessage(
  check: ConfigCheck | null,
  options: ConfigOptionView[] = [],
): string | null {
  if (!check || check.status === "ready") return null;
  if (check.status === "record_failed")
    return STRINGS.repair.configRecordFailed;
  const details = check.issues.map((issue) => {
    const option = options.find((option) => option.id === issue.id);
    const publicName = option?.name;
    const name =
      (publicName &&
      issue.id &&
      options.some(
        (other) => other.id !== issue.id && other.name === publicName,
      )
        ? `${publicName}（${issue.id}）`
        : publicName) ??
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
