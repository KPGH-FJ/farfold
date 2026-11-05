import type { PermissionOption } from "./session_types";

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
