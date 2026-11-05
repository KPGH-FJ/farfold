import type { PendingPermission, PermissionOption } from "./session_types";
import { STRINGS } from "./strings";

/** Reply identity is separate from the meaning of an unfamiliar choice kind. */
export function permissionDecision(
  option: PermissionOption,
): NonNullable<PendingPermission["decision"]> {
  const allow =
    option.kind === "allow_once" || option.kind === "allow_always"
      ? true
      : option.kind === "reject_once" || option.kind === "reject_always"
        ? false
        : null;
  return {
    optionId: option.optionId,
    label:
      allow === true
        ? STRINGS.thread.approved(option.name)
        : allow === false
          ? STRINGS.thread.rejected
          : STRINGS.thread.permissionChoiceSubmitted(
              option.name || option.optionId,
            ),
    allow,
    undoable: option.kind === "allow_always",
  };
}

/** An ID must select exactly one advertised choice, without type coercion. */
export function selectablePermissionOption(
  options: PermissionOption[],
  option: PermissionOption,
): boolean {
  return (
    !option.invalidId &&
    options.filter(
      (candidate) =>
        !candidate.invalidId && candidate.optionId === option.optionId,
    ).length === 1
  );
}
