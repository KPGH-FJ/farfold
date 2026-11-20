import type { AccountIdentity, AuthMethodInfo } from "../runtime/agents";
import type {
  OfficialMethodRole,
  PreparationAction,
} from "../runtime/preparation";
import { authMethodUnavailable } from "../runtime/auth_method";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { PREPARATION_ACTION_STRINGS as P } from "../runtime/preparation_action_strings";
import type { ApiConfigurationState } from "../runtime/service_capability";
import type { AgentConnectionPresentation } from "./agent_auth_types";
import type { ConnectionOption } from "./AgentConnectionPicker";

/** Official roles describe the route's purpose without changing its transport. */
export function authMethodGroup(
  method: AuthMethodInfo,
  roles: readonly OfficialMethodRole[],
) {
  const role = roles.find((item) => item.methodId === method.id)?.role;
  if (role === "reuse") return R.groupReuse;
  if (role === "credential" || method.kind === "api-key") return R.groupApiKey;
  if (role === "configuration") return R.groupConfiguration;
  if (method.kind === "agent") return R.groupAgent;
  if (method.kind === "terminal") return R.groupTerminal;
  if (method.kind === "environment") return R.groupEnvironment;
}

export function currentMethodRoles(
  methods: readonly AuthMethodInfo[],
  roles: readonly OfficialMethodRole[],
) {
  return roles.filter(({ methodId, kind }) => {
    const matching = methods.filter(({ id }) => id === methodId);
    return matching.length === 1 && matching[0].kind === kind;
  });
}

export function authMethodContinue(
  method: AuthMethodInfo,
  roles: readonly OfficialMethodRole[],
  isLoginAgain: boolean,
  loginAgainLabel: string,
) {
  if (method.kind === "terminal") return R.terminalStart;
  switch (authMethodGroup(method, roles)) {
    case R.groupApiKey:
      return R.keyContinue(methodTitle(method));
    case R.groupReuse:
      return R.reuseContinue;
    case R.groupConfiguration:
      return R.configureContinue(methodTitle(method));
    default:
      return isLoginAgain
        ? loginAgainLabel
        : R.accountContinue(methodTitle(method));
  }
}

const groupOrder: readonly (string | undefined)[] = [
  undefined,
  R.groupReuse,
  R.groupAgent,
  R.groupTerminal,
  R.groupApiKey,
  R.groupEnvironment,
  R.groupConfiguration,
];

/** List order follows declared kind groups; the Agent's own order is kept
 *  inside each group. */
export const groupedAuthMethods = (
  methods: readonly AuthMethodInfo[],
  roles: readonly OfficialMethodRole[],
) =>
  [...methods].sort(
    (a, b) =>
      groupOrder.indexOf(authMethodGroup(a, roles)) -
      groupOrder.indexOf(authMethodGroup(b, roles)),
  );

/** The primary text is always the Agent-provided method name. */
export const methodTitle = (method: AuthMethodInfo) => method.name;

const methodDescription = (method: AuthMethodInfo, group?: string) => {
  const unavailable = authMethodUnavailable(method);
  if (unavailable)
    return method.envNames?.length
      ? `${unavailable}：${method.envNames.join("、")}`
      : unavailable;
  if (group === R.groupReuse) return R.reuseHint;
  if (group === R.groupApiKey && method.kind === "terminal")
    return R.credentialHint;
  return (
    method.description ??
    (method.kind === "terminal"
      ? R.terminalHint
      : method.kind === "api-key"
        ? R.keyHint
        : method.kind === "environment"
          ? R.environmentHint
          : R.accountHint)
  );
};

/** One flat option list: existing settings first (ungrouped), then declared
 *  methods grouped by kind, then service actions and the API route. */
export function authConnectionOptions({
  connection,
  existingAccount,
  methods,
  actions,
  apiState,
  roles = [],
}: {
  connection?: AgentConnectionPresentation;
  existingAccount: AccountIdentity | null;
  methods: readonly AuthMethodInfo[];
  actions: readonly PreparationAction[];
  apiState: ApiConfigurationState;
  roles?: readonly OfficialMethodRole[];
}): ConnectionOption[] {
  const existingDescription = connection?.authRequired
    ? R.existingNeedsLogin
    : existingAccount
      ? [
          existingAccount.email ?? existingAccount.displayName,
          existingAccount.plan,
        ]
          .filter(Boolean)
          .join(" · ") || R.existingHint
      : R.existingHint;
  return [
    ...(connection
      ? [
          {
            id: JSON.stringify(["existing"]),
            title: R.existing,
            description: existingDescription,
            disabled: false,
          },
        ]
      : []),
    ...groupedAuthMethods(methods, roles).map((method) => {
      const group = authMethodGroup(method, roles);
      return {
        id: JSON.stringify(["method", method.id]),
        title: methodTitle(method),
        description: methodDescription(method, group),
        disabled: !!authMethodUnavailable(method),
        group,
      };
    }),
    ...actions.map((action) => ({
      id: JSON.stringify(["action", action.id]),
      title:
        action.purpose === "account_login"
          ? P.accountLogin.title
          : R.serviceTerminal,
      description:
        action.purpose === "account_login"
          ? P.accountLogin.hint
          : R.serviceTerminalHint,
      group:
        action.purpose === "service_configuration"
          ? R.groupConfiguration
          : undefined,
      disabled: false,
    })),
    ...(connection && apiState !== "unsupported"
      ? [
          {
            id: JSON.stringify(["api"]),
            title: R.api,
            description: connection.apiAvailable
              ? R.apiHint
              : R.apiUnavailableHint,
            disabled: !connection.apiAvailable,
          },
        ]
      : []),
  ];
}
