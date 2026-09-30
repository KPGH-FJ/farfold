import { accountRoute } from "./account-capabilities.js";
import { manualAuthenticationMethod } from "./authentication-state.js";
import { startAgentJob } from "./access-jobs.js";

const documentedTerminal = (route) =>
  route?.kind === "terminal" &&
  route.evidence === "official-doc" &&
  route.execution === "simulation-only";
const matchingCommand = (route, method) =>
  route?.command === method?.command &&
  JSON.stringify(route?.args || []) === JSON.stringify(method?.args || []);

// Documentation identifies a possible action, not an installed executable or
// a protocol capability. The UI must explicitly confirm the matching program.
export function officialAccountProgramConfirmed(agent, routeId) {
  const route = accountRoute(agent, routeId);
  const confirmation = agent.accountProgramConfirmation;
  return !!(
    documentedTerminal(route) &&
    confirmation?.routeId === route.id &&
    matchingCommand(route, confirmation)
  );
}

// Review-only confirmation. This never detects a CLI or runs a real command.
export function confirmOfficialAccountProgram(agent, routeId) {
  const route = accountRoute(agent, routeId);
  if (!documentedTerminal(route) || agent.accessJob) return agent;
  return {
    ...agent,
    accountProgramConfirmation: {
      routeId: route.id,
      command: route.command,
      args: [...(route.args || [])],
    },
  };
}

export function officialAccountRouteIssue(agent, routeId) {
  const route = accountRoute(agent, routeId);
  if (!documentedTerminal(route)) return "这个登录设置入口已不可用。";
  if (!officialAccountProgramConfirmed(agent, routeId))
    return "请先确认用于登录的程序。连接成功不代表这个登录程序已经安装。";
  return null;
}

// Selecting a route does not convert it into a program-declared authMethod.
export function selectedOfficialAccountRoute(agent, method) {
  const route = accountRoute(agent, agent.accountRouteSelection);
  return documentedTerminal(route) &&
    method?.manual &&
    matchingCommand(route, method)
    ? route
    : null;
}

export function startOfficialAccountRoute(agent, routeId, options = {}) {
  const route = accountRoute(agent, routeId);
  if (officialAccountRouteIssue(agent, routeId)) return agent;
  const method = manualAuthenticationMethod(
    route.command || "",
    (route.args || []).join("\n"),
  );
  if (!method) return agent;
  const next = startAgentJob(agent, "auth", { ...options, authMethod: method });
  return next === agent
    ? agent
    : {
        ...next,
        accountRouteSelection: route.id,
        authMethodSelection: method.id,
        accessJob: {
          ...next.accessJob,
          accountActionPurpose: options.accountActionPurpose || "settings",
          accountRoutePurpose: route.purpose,
          label:
            options.accountActionPurpose === "registration"
              ? "等待完成注册与登录"
              : route.purpose === "service"
                ? "等待完成服务配置"
                : "等待登录授权",
        },
      };
}
