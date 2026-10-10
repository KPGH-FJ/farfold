import { invoke } from "@tauri-apps/api/core";
import type { SkillManagementPort } from "./skill_management";
export const mcpRemovePort: SkillManagementPort = {
  inspect: (input) => invoke("agent_mcp_remove_inspect", { ...input }),
  confirm: (input) => invoke("agent_mcp_remove_confirm", { ...input }),
  status: ({ agentId, requestId }) =>
    invoke("agent_mcp_remove_status", { agentId, requestId }),
  cancel: ({ agentId, requestId }) =>
    invoke("agent_mcp_remove_cancel", { agentId, requestId }),
  recheck: (input) => invoke("agent_mcp_remove_recheck", { ...input }),
};
