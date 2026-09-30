import {
  accountRequiredForSelection,
  clearAgentAuthenticationRequirement,
  rememberAgentAuthenticationRequirement,
} from "./authentication-state.js";
import { usesApi } from "./service-access.js";
import { clearEntitlementFailure } from "./selection-entitlement.js";

export const FIRST_SEND_AUTH_FAILURES = [
  "auth",
  "agent_auth",
  "service_auth",
  "authentication_unknown",
];

export function firstSendAuthDestination(agent, context) {
  return agent?.accessJob?.type === "auth" ||
    accountRequiredForSelection(agent || {}, {
      ...context.choice,
      folder: context.folder,
    }) ||
    !usesApi(context.choice)
    ? "agent"
    : "service";
}

// This describes a rejected prototype message. It neither creates history nor
// executes authentication, and never infers a key failure from choosing an API.
export function firstSendFailure(agent, attempt) {
  const choice = attempt.draft.choice;
  const selection = { ...choice, folder: attempt.draft.folder };
  const api = usesApi(choice);
  const layer = ["auth", "agent_auth"].includes(attempt.outcome)
    ? "agent"
    : attempt.outcome === "service_auth" && api && attempt.service?.id
      ? "service"
      : FIRST_SEND_AUTH_FAILURES.includes(attempt.outcome)
        ? "unknown"
        : null;
  if (layer === "agent")
    return {
      agent: rememberAgentAuthenticationRequirement(agent, selection),
      layer,
      rememberBlock: !api,
      message:
        "这个 Agent 要求登录。草稿与所选来源已保留，完成登录后可重新发送。",
    };
  if (layer === "service") {
    const serviceId = attempt.service.id;
    const secretRevision = attempt.service.secretRevision || 0;
    return {
      agent: {
        ...agent,
        serviceAuthIssues: [
          ...(agent.serviceAuthIssues || []).filter(
            (issue) =>
              issue.serviceId !== serviceId ||
              issue.secretRevision !== secretRevision,
          ),
          { serviceId, secretRevision },
        ],
      },
      layer,
      rememberBlock: true,
      message:
        "所选 API 服务认证失败。草稿已保留，请更新该服务的密钥后再发送。",
    };
  }
  return {
    agent,
    layer,
    rememberBlock: false,
    message:
      layer === "unknown"
        ? "这条消息因认证问题未发出，但无法确认需要登录账号还是更新服务密钥。草稿已保留，请检查后重试。"
        : "这条消息没有发出。内容与附件已保留，可以重试。",
  };
}

// Successful admission settles observations for this exact message choice only.
// Unknown/rejected attempts and another Agent cannot erase a known failure.
export function settleSuccessfulFirstSend(agent, attempt) {
  const choice = attempt?.draft?.choice;
  if (
    attempt?.outcome !== "success" ||
    !choice ||
    (choice.agentId ? choice.agentId !== agent.id : choice.agent !== agent.name)
  )
    return agent;
  const selection = { ...choice, folder: attempt.draft.folder };
  return clearEntitlementFailure(
    clearAgentAuthenticationRequirement(agent, selection),
    selection,
    attempt.service,
  );
}
