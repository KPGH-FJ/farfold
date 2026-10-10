import { invoke } from "@tauri-apps/api/core";
import type { SkillManagementPort } from "./skill_management";
export const mcpManagementPort: SkillManagementPort = {
  inspect: (input) => invoke("agent_mcp_change_inspect", { ...input }),
  confirm: (input) => invoke("agent_mcp_change_confirm", { ...input }),
  status: ({ agentId, requestId }) =>
    invoke("agent_mcp_change_status", { agentId, requestId }),
  cancel: ({ agentId, requestId }) =>
    invoke("agent_mcp_change_cancel", { agentId, requestId }),
  recheck: (input) => invoke("agent_mcp_change_recheck", { ...input }),
};
