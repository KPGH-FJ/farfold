import type { ConfigOptionView } from "./session_types";
import { STRINGS } from "./strings";
import { toUiNotice, type UiNotice } from "./ui_error";
import type { ConfigBusyReason } from "./protected_config";

const confirmationReasons = {
  ...STRINGS.repair.confirmConfigReasons,
  ...STRINGS.repair.confirmConfigNativeReasons,
};
type ConfirmationFailure = keyof typeof confirmationReasons;
const confirmationNotices = new WeakSet<UiNotice>();

/** Separate from saved-option feedback: a confirmation error never changes retry policy. */
export class ConfigurationConfirmationError extends Error {
  readonly detail: string;

  constructor(reason: ConfirmationFailure, busy?: ConfigBusyReason) {
    super(STRINGS.repair.confirmConfigFailed);
    this.detail = busy
      ? `${confirmationReasons[reason]}：${STRINGS.repair.confirmConfigBusyReasons[busy]}。`
      : confirmationReasons[reason];
  }
}

/** Only an exact app-owned string code is eligible; never inspect arbitrary payloads. */
export function configurationConfirmationRejection(
  reason: unknown,
): ConfigurationConfirmationError {
  const code =
    typeof reason === "string" &&
    Object.hasOwn(STRINGS.repair.confirmConfigNativeReasons, reason)
      ? (reason as keyof typeof STRINGS.repair.confirmConfigNativeReasons)
      : "invoke-rejected";
  return new ConfigurationConfirmationError(code);
}

/** Only our local fixed classification is presentable; never use an IPC error's text. */
export function configurationConfirmationNotice(
  reason: unknown,
): UiNotice | null {
  if (!(reason instanceof ConfigurationConfirmationError)) return null;
  const notice = {
    message: STRINGS.repair.confirmConfigFailed,
    detail: reason.detail,
  };
  confirmationNotices.add(notice);
  return notice;
}

/** Selection failures show only local fixed detail; unknown payloads stay private. */
export function configurationApplyNotice(
  reason: unknown,
  fallback: string = STRINGS.repair.configFailed,
): UiNotice {
  return configurationConfirmationNotice(reason) ?? { message: fallback };
}

/** A matching local notice enriches the current guard; it never clears it. */
export function confirmationFeedback(
  notice: UiNotice | null,
  configError: string | null | undefined,
): UiNotice | string | null {
  return notice &&
    confirmationNotices.has(notice) &&
    notice.message === configError
    ? notice
    : (configError ?? null);
}

/** Keep preparation feedback selection in one place without changing retry markers. */
export function configurationPreparationNotice(reason: unknown): UiNotice {
  return (
    configurationConfirmationNotice(reason) ??
    configurationRestoreNotice(reason) ??
    toUiNotice(reason, STRINGS.repair.requestFailed)
  );
}

type RestoreFailure =
  "missing-option" | "value-unavailable" | "readback-unconfirmed";
const messages: Record<RestoreFailure, string> = {
  "missing-option": STRINGS.repair.savedConfigMissing,
  "value-unavailable": STRINGS.repair.savedConfigUnavailable,
  "readback-unconfirmed": STRINGS.repair.savedConfigReadback,
};

/** Only local comparisons establish these reasons; setter errors stay unclassified. */
class SavedConfigurationRestoreError extends Error {
  constructor(reason: RestoreFailure) {
    super(messages[reason]);
  }
}

export function requireSavedConfigurationOption(
  options: readonly ConfigOptionView[] | undefined,
  id: string,
  value: unknown,
): ConfigOptionView {
  if (!options) throw new Error(STRINGS.repair.configFailed);
  const option = options.find((item) => item.id === id);
  if (!option) throw new SavedConfigurationRestoreError("missing-option");
  if (
    value !== option.currentValue &&
    option.type === "select" &&
    !option.options.some((item) => item.value === value)
  )
    throw new SavedConfigurationRestoreError("value-unavailable");
  return option;
}

export function requireRestoredConfigurationValues(
  options: readonly ConfigOptionView[] | undefined,
  choices: readonly (readonly [string, unknown])[],
): void {
  if (!choices.length) return;
  if (!options) throw new Error(STRINGS.repair.configFailed);
  if (
    choices.some(
      ([id, value]) =>
        options.find((item) => item.id === id)?.currentValue !== value,
    )
  )
    throw new SavedConfigurationRestoreError("readback-unconfirmed");
}

interface RestoreNotice extends UiNotice {
  savedConfigurationRestore: true;
}
export function configurationRestoreNotice(
  reason: unknown,
): RestoreNotice | null {
  return reason instanceof SavedConfigurationRestoreError
    ? { message: reason.message, savedConfigurationRestore: true }
    : null;
}

export function isConfigurationRestoreNotice(notice: UiNotice | null): boolean {
  return (
    !!notice &&
    "savedConfigurationRestore" in notice &&
    notice.savedConfigurationRestore === true
  );
}
