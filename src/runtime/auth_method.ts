import type { AuthMethodInfo } from "./agents";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";

type DeclaredMethod = Pick<AuthMethodInfo, "kind"> &
  Partial<Pick<AuthMethodInfo, "unavailableReason">>;

export function authMethodReadOnly(method: DeclaredMethod) {
  return method.kind === "environment" || method.kind === "unsupported";
}

/** These declaration kinds cannot silently fall back to authenticate. */
export function authMethodUnavailable(method: DeclaredMethod) {
  return (
    method.unavailableReason ||
    (method.kind === "environment"
      ? S.environment
      : method.kind === "unsupported"
        ? S.unsupported
        : null)
  );
}
