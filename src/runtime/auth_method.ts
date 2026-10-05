import type { AuthMethodInfo } from "./agents";
import { AUTH_ACTIVITY_STRINGS as S } from "./auth_strings";
import { METHOD_API_KEY_STRINGS as K } from "./method_api_key_strings";

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

type NamedMethod = Pick<AuthMethodInfo, "id" | "name" | "kind"> &
  Partial<Pick<AuthMethodInfo, "purpose" | "apiKeyProvider">>;
const visibleName = (name: string) => name.trim().replace(/\s+/g, " ");

/** A display label never selects a route or changes the public method ID. */
export function authMethodLabel(
  method: NamedMethod,
  methods: readonly NamedMethod[],
): string {
  const sameName = methods.filter(
    (other) => visibleName(other.name) === visibleName(method.name),
  );
  if (sameName.length < 2) return method.name;
  const description =
    method.kind === "agent"
      ? S.methodAgent
      : method.kind === "terminal"
        ? method.purpose === "setup"
          ? S.methodSetup
          : S.methodTerminal
        : method.kind === "api-key"
          ? method.apiKeyProvider
            ? K.methodLabel
            : S.methodApi
          : method.kind === "environment"
            ? S.methodEnvironment
            : S.methodUnsupported;
  const identity =
    sameName.filter((other) => other.kind === method.kind).length > 1
      ? ` · ${method.id}`
      : "";
  return `${method.name}（${description}${identity}）`;
}
