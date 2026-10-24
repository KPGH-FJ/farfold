import type { ConfigOptionView } from "./session_types";
import { STRINGS } from "./strings";
import type { UiNotice } from "./ui_error";

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
