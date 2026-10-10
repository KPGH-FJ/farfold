import { invoke } from "@tauri-apps/api/core";
import type {
  SkillChangeInspectInput,
  SkillChangeConfirmInput,
  SkillChangeRequestKey,
  SkillChangeRecheckInput,
} from "./skill_management_types";
export interface SkillManagementPort {
  inspect(input: SkillChangeInspectInput): Promise<unknown>;
  confirm(input: SkillChangeConfirmInput): Promise<unknown>;
  status(input: SkillChangeRequestKey): Promise<unknown>;
  cancel(input: SkillChangeRequestKey): Promise<unknown>;
  recheck(input: SkillChangeRecheckInput): Promise<unknown>;
}
export const skillManagementPort: SkillManagementPort = {
  inspect: (input) => invoke("agent_skill_change_inspect", { ...input }),
  confirm: (input) => invoke("agent_skill_change_confirm", { ...input }),
  status: ({ agentId, requestId }) =>
    invoke("agent_skill_change_status", { agentId, requestId }),
  cancel: ({ agentId, requestId }) =>
    invoke("agent_skill_change_cancel", { agentId, requestId }),
  recheck: (input) => invoke("agent_skill_change_recheck", { ...input }),
};
