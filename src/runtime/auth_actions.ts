import { Channel, invoke } from "@tauri-apps/api/core";
import type { AuthTarget } from "./auth_activity";
import { authenticationActivity } from "./authentication";
import {
  authRun,
  agentLogout,
  ptyAwait,
  ptyClose,
  type AuthMethodInfo,
  type PtyChunk,
} from "./agents";
import type { PreparationAction } from "./preparation";
import { preparationFor } from "./agent_preparation";
import { PREPARATION_ACTION_STRINGS as P } from "./preparation_action_strings";
import { STRINGS } from "./strings";
import { AUTH_ACTIVITY_STRINGS as A } from "./auth_strings";
import { authMethodUnavailable } from "./auth_method";
import { METHOD_API_KEY_STRINGS } from "./method_api_key_strings";

export async function recheckAuthentication(
  target: AuthTarget,
  onChanged: () => Promise<void>,
) {
  await preparationFor(target.agentId).prepareForAccount(target);
  await invoke("auth_recheck", { ...target });
  await onChanged();
}

export function beginAuthentication(input: {
  target: AuthTarget;
  method: Pick<AuthMethodInfo, "id" | "kind"> &
    Partial<
      Pick<
        AuthMethodInfo,
        "name" | "completion" | "unavailableReason" | "apiKeyProvider"
      >
    >;
  manual?: boolean;
  logout?: boolean;
  switchAccount?: boolean;
  credentialId?: string;
  credentialRevision?: string;
  onChanged: () => Promise<void>;
}) {
  const target = { ...input.target },
    method = { ...input.method },
    credentialId = input.credentialId,
    credentialRevision = input.credentialRevision;
  const unavailable = authMethodUnavailable(method);
  if (unavailable && !input.manual && !input.logout)
    throw new Error(unavailable);
  if (
    method.kind === "api-key" &&
    !input.manual &&
    !input.logout &&
    (!method.apiKeyProvider || !credentialId || !credentialRevision)
  )
    throw new Error(METHOD_API_KEY_STRINGS.required);
  const activity = authenticationActivity(target.agentId);
  const attemptId = crypto.randomUUID();
  const intent = input.logout
    ? input.switchAccount
      ? "switch_account"
      : "logout"
    : "login";
  activity.begin(
    target,
    {
      kind: "authentication",
      methodId: method.id,
      title: input.logout
        ? input.switchAccount
          ? A.switchAccount
          : STRINGS.agents.auth.logout
        : (method.name ?? STRINGS.agents.auth.heading),
      completion: method.completion ?? "exit_code",
      intent,
    },
    attemptId,
  );
  const cleanup = preparationFor(target.agentId).prepareForAccount(target);
  const beforeRun = async () => {
    if (cleanup) await cleanup;
    if (!activity.canStart(attemptId)) throw new Error("AUTH_CANCELLED");
  };
  // Always return to the initiating directory without replacing other sources.
  const reconnect = () => recheckAuthentication(target, input.onChanged);
  if (method.kind === "terminal" || input.manual) {
    activity.terminal({
      start: async (output) => {
        await beforeRun();
        const channel = new Channel<PtyChunk>();
        channel.onmessage = (chunk) => {
          if (typeof chunk.data === "string") output(chunk.data);
        };
        return input.manual
          ? invoke<string>("auth_manual_run", {
              ...target,
              methodId: method.id,
              attemptId,
              onOutput: channel,
            })
          : authRun(target.agentId, method.id, {
              ...target,
              attemptId,
              viaTerminal: true,
              onOutput: channel,
            }).then((result) => {
              if (result?.kind !== "terminal" || !result.ptyId)
                throw new Error(A.methodChanged);
              return result.ptyId;
            });
      },
      wait: ptyAwait,
      close: ptyClose,
      cancel: () =>
        invoke("auth_cancel", { agentId: target.agentId, attemptId }),
      reconnect,
    });
  } else {
    void activity.protocol({
      run: async (unknown) => {
        await beforeRun();
        const channel = new Channel<PtyChunk>();
        channel.onmessage = (chunk) => {
          if (chunk.authStatus === "unknown") unknown();
          activity.inquiryEvent(attemptId, chunk);
        };
        const options = {
          ...target,
          attemptId,
          onOutput: channel,
          ...(method.kind === "api-key" && !input.logout
            ? {
                credentialId,
                credentialRevision,
              }
            : {}),
        };
        if (input.logout) return agentLogout(target.agentId, options);
        const result = await authRun(target.agentId, method.id, options);
        // A terminal startup is not an authenticate success response. The
        // backend rejects route drift before launch; retain this reply check
        // so an unexpected result cannot be presented as confirmed login.
        if (result?.kind !== "agent" || result.ptyId != null)
          throw new Error(A.methodChanged);
        return result;
      },
      cancel: () =>
        invoke("auth_cancel", { agentId: target.agentId, attemptId }),
      end: () => invoke("auth_end", { agentId: target.agentId, attemptId }),
      reconnect: async () => {
        if (input.logout) return reconnect();
        // Preserve the connection that accepted authentication. Terminal
        // configuration and logout still use their explicit replacement check.
        await invoke("auth_refresh", { ...target });
        await input.onChanged();
      },
    });
  }
  return activity;
}

export function beginPreparationAction(input: {
  target: AuthTarget;
  action: PreparationAction;
  onChanged: () => Promise<void>;
}) {
  const target = { ...input.target };
  const action = { ...input.action, args: [...input.action.args] };
  const activity = authenticationActivity(target.agentId);
  const attemptId = crypto.randomUUID();
  activity.begin(
    target,
    {
      kind: "preparation",
      actionId: action.id,
      purpose: action.purpose,
      title:
        action.purpose === "account_login" ? P.accountLogin.title : P.title,
      completion: "exit_code",
    },
    attemptId,
  );
  const controller = preparationFor(target.agentId);
  const cleanup = controller.prepareForAccount(target);
  controller.requireExplicitRead(target, false);
  activity.terminal({
    start: async (output) => {
      if (cleanup) await cleanup;
      if (!activity.canStart(attemptId)) throw new Error("AUTH_CANCELLED");
      const onOutput = new Channel<PtyChunk>();
      onOutput.onmessage = (chunk) => {
        if (typeof chunk.data === "string") output(chunk.data);
      };
      return invoke<string>("agent_preparation_action_run", {
        ...target,
        actionId: action.id,
        attemptId,
        expectedCommand: action.command,
        expectedArgs: action.args,
        onOutput,
      });
    },
    wait: ptyAwait,
    close: ptyClose,
    cancel: () => invoke("auth_cancel", { agentId: target.agentId, attemptId }),
    reconnect: () => recheckAuthentication(target, input.onChanged),
  });
  return activity;
}
