import type { AgentCardModel } from "./agents";
import { isAgentPresentable } from "./agent_directory";
import { hasSavedAgentPreparation } from "./agent_readiness";

/** 唯一的“我的 Agent”定义：已安装、已连接、自定义、保存过准备或带有
 *  会话历史的可见条目。侧栏、Agent 管理与开始页引导共用此判断。 */
export function isMyAgent(
  card: AgentCardModel,
  historyAgentIds: ReadonlySet<string>,
): boolean {
  return (
    isAgentPresentable(card) &&
    (card.status === "installed" ||
      card.status === "connected" ||
      card.custom ||
      hasSavedAgentPreparation(card.id) ||
      historyAgentIds.has(card.id))
  );
}
