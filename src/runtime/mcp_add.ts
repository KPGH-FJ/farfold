import { invoke } from "@tauri-apps/api/core";
import type { SkillManagementPort } from "./skill_management";
export const mcpAddPort: SkillManagementPort = {
  inspect: (input) => invoke("agent_mcp_add_inspect", { ...input }),
  confirm: (input) => invoke("agent_mcp_add_confirm", { ...input }),
  status: ({ agentId, requestId }) =>
    invoke("agent_mcp_add_status", { agentId, requestId }),
  cancel: ({ agentId, requestId }) =>
    invoke("agent_mcp_add_cancel", { agentId, requestId }),
  recheck: (input) => invoke("agent_mcp_add_recheck", { ...input }),
};
