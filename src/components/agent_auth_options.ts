import type { AccountIdentity, AuthMethodInfo } from "../runtime/agents";
import type { PreparationAction } from "../runtime/preparation";
import { authMethodUnavailable } from "../runtime/auth_method";
import { CONNECTION_STRINGS as R } from "../runtime/r5_auth_strings";
import { PREPARATION_ACTION_STRINGS as P } from "../runtime/preparation_action_strings";
import type { ApiConfigurationState } from "../runtime/service_capability";
import type { AgentConnectionPresentation } from "./agent_auth_types";
import type { ConnectionOption } from "./AgentConnectionPicker";

/** Declared kind is authoritative for grouping; names are never inspected. */
const methodGroup = (kind: string) =>
  kind === "agent"
    ? R.groupAgent
    : kind === "terminal"
      ? R.groupTerminal
      : kind === "api-key"
        ? R.groupApiKey
        : kind === "environment"
          ? R.groupEnvironment
          : undefined;
const groupOrder = ["agent", "terminal", "api-key", "environment"];

/** List order follows declared kind groups; the Agent's own order is kept
 *  inside each group. */
export const groupedAuthMethods = (methods: readonly AuthMethodInfo[]) =>
  [...methods].sort(
    (a, b) => groupOrder.indexOf(a.kind) - groupOrder.indexOf(b.kind),
  );

/** The primary text is always the Agent-provided method name. */
export const methodTitle = (method: AuthMethodInfo) => method.name;

const methodDescription = (method: AuthMethodInfo) => {
  const unavailable = authMethodUnavailable(method);
  if (unavailable)
    return method.envNames?.length
      ? `${unavailable}：${method.envNames.join("、")}`
      : unavailable;
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
}: {
  connection?: AgentConnectionPresentation;
  existingAccount: AccountIdentity | null;
  methods: readonly AuthMethodInfo[];
  actions: readonly PreparationAction[];
  apiState: ApiConfigurationState;
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
    ...groupedAuthMethods(methods).map((method) => ({
      id: JSON.stringify(["method", method.id]),
      title: methodTitle(method),
      description: methodDescription(method),
      disabled: !!authMethodUnavailable(method),
      group: methodGroup(method.kind),
    })),
    ...actions.map((action) => ({
      id: JSON.stringify(["action", action.id]),
      title:
        action.purpose === "account_login"
          ? P.accountLogin.title
          : R.serviceTerminal,
      description:
        action.purpose === "account_login"
          ? P.accountLogin.hint
          : R.terminalHint,
      disabled: false,
    })),
    ...(connection && apiState !== "unsupported"
      ? [
          {
            id: JSON.stringify(["api"]),
            title: R.api,
            description: R.apiHint,
            disabled: !connection.apiAvailable,
          },
        ]
      : []),
  ];
}
