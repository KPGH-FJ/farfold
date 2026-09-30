import type { AgentSetupProgress } from "../components/AgentSetup";
import type { ThreadState, ConfigOptionView } from "./session_types";
import { pendingPreparationRead } from "./agent_preparation";

export function draftPreparationRequired(
  thread: ThreadState | null | undefined,
) {
  return (
    !!thread &&
    (thread.identity === "draft" ||
      thread.modelDrift ||
      thread.unrecoverable) &&
    pendingPreparationRead(thread)
  );
}

/** A separate preparation retains the caller's choices; it cannot edit the old conversation. */
export function draftPreparationSelection(thread: ThreadState) {
  if (thread.service) return undefined;
  return {
    service: null,
    config: Object.fromEntries(
      thread.configOptions.map((option) => [option.id, option.currentValue]),
    ),
  };
}

export type AgentRepairPanel = "account" | "model" | "program";
export interface AgentRepairRequest {
  panel: AgentRepairPanel;
  needsAuthentication?: boolean;
  sourceContext?: string;
}
export interface ConversationRepairContext {
  key: string;
  service?: ThreadState["service"];
  sourceContext?: string;
  configOptions: ConfigOptionView[];
  recordedModel?: string;
}

export function agentRepairPanel(
  thread: ThreadState | null | undefined,
  needsAuthentication: boolean,
): AgentRepairPanel {
  if (needsAuthentication || thread?.sourceError) return "account";
  if (thread?.modelDrift || thread?.configError) return "model";
  return "program";
}

/** A repair locates an existing choice; it never adopts another service or model. */
export function locateAgentRepair(
  progress: AgentSetupProgress,
  repair: AgentRepairRequest,
): AgentSetupProgress {
  return {
    ...progress,
    step: { account: 1, model: 2, program: 0 }[repair.panel],
    ...(repair.panel === "account" &&
    repair.needsAuthentication &&
    !repair.sourceContext &&
    !progress.selection?.service &&
    progress.choice !== "api"
      ? { choice: "login" as const }
      : {}),
  };
}

export function conversationRepairContext(
  thread: ThreadState,
): ConversationRepairContext {
  return {
    key: thread.key,
    service: thread.service ? { ...thread.service } : undefined,
    sourceContext:
      thread.serviceContext ??
      (thread.service ? JSON.stringify(thread.service) : undefined),
    configOptions: structuredClone(thread.configOptions),
    recordedModel: thread.recordedModel,
  };
}
