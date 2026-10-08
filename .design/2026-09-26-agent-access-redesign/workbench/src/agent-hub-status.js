import { authenticationRequiredContexts } from "./authentication-state.js";
import { serviceAuthenticationIssue } from "./service-access.js";
import {
  agentProgramReady,
  agentNeedsInitialPreparation,
} from "./agent-setup-state.js";

// Directory summaries describe known scopes; they never decide whether a
// different folder or source may be tried. `ready` controls icon styling only.
export function agentHubStatus(agent, services = []) {
  const notice = (label) => ({ label, ready: false });
  if (agent.accessJob)
    return notice(
      agent.accessJob.type === "connect"
        ? "正在检查程序"
        : agent.accessJob.label,
    );
  if (agent.removed) return notice("已移除接入");
  if (agent.dependenciesMissing) return notice("缺少必要程序");
  if (agent.connectionState === "failed") return notice("程序检查失败");
  if (agent.connectionState === "unknown") return notice("程序检查结果待确认");
  if (agent.connectionState === "connecting") return notice("正在检查程序");

  const liveServiceIds = new Set(
    services
      .filter((service) => !service.deleting)
      .map((service) => service.id),
  );
  const accountRequired =
    authenticationRequiredContexts(agent).length > 0 ||
    (agent.authRequiredApiSelections || []).some((observation) => {
      try {
        const scope = JSON.parse(observation);
        return (
          Array.isArray(scope) &&
          scope.length === 2 &&
          typeof scope[0] === "string" &&
          liveServiceIds.has(scope[1])
        );
      } catch {
        return false;
      }
    });
  const serviceRequired = services.some(
    (service) =>
      !service.deleting && serviceAuthenticationIssue(agent, service),
  );
  if (accountRequired && serviceRequired)
    return notice("部分工作需要检查账号或 API 密钥");
  if (accountRequired) return notice("部分工作需要登录");
  if (serviceRequired) return notice("部分 API 服务需要更新密钥");

  if (agentProgramReady(agent))
    return agentNeedsInitialPreparation(agent)
      ? notice("未完成设置")
      : { label: "可以使用", ready: true };
  if (agent.registered)
    return notice(
      agentNeedsInitialPreparation(agent) ? "未完成设置" : "等待自动检查",
    );
  if (agent.installations?.length) return notice("本机发现");
  return notice("尚未安装");
}
