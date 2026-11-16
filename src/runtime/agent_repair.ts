import type { AgentSetupProgress } from "../components/AgentSetup";
import type { ThreadState, ConfigOptionView } from "./session_types";
import { pendingPreparationRead } from "./agent_preparation";
import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
} from "./drafts";
import { sameConfigurationSnapshot } from "./config_check";
import { isConfigurationRestoreNotice } from "./configuration_restore_feedback";
import { STRINGS } from "./strings";
import type { UiNotice } from "./ui_error";

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
  draftConfiguration?: boolean;
}

/** Repair belongs to the unsent draft and the service that opened the review. */
export function captureDraftConfigurationRepair() {
  const draft = composerDrafts.read("new");
  const generation = composerDrafts.generation("new");
  const choice = structuredClone({ ...newConversationChoice });
  return (selection: NonNullable<AgentSetupProgress["selection"]>) =>
    composerDrafts.read("new") === draft &&
    composerDrafts.generation("new") === generation &&
    !draft.sendPending &&
    !draft.pendingConversation &&
    !draftPersistence.snapshot().interactionLocked &&
    sameConfigurationSnapshot(choice, newConversationChoice) &&
    sameConfigurationSnapshot(choice.service, selection.service);
}

export function newDraftRepairRequest(
  thread: ThreadState | null,
  needsAuthentication: boolean,
  sourceContext: string | undefined,
  explicitReadRequired: boolean,
  error: UiNotice | null,
): AgentRepairRequest {
  const draftConfiguration =
    !needsAuthentication &&
    !explicitReadRequired &&
    isConfigurationRestoreNotice(error);
  return {
    panel:
      explicitReadRequired ||
      draftConfiguration ||
      (!needsAuthentication &&
        (error?.message === STRINGS.repair.configFailed ||
          error?.message === STRINGS.repair.confirmConfigFailed))
        ? "model"
        : agentRepairPanel(thread, needsAuthentication),
    needsAuthentication,
    sourceContext,
    ...(draftConfiguration ? { draftConfiguration: true } : {}),
  };
}
export interface ConversationRepairContext {
  key: string;
  service?: ThreadState["service"];
  sourceContext?: string;
  configOptions: ConfigOptionView[];
  protectedIds?: string[];
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
    ...(thread.configCheck?.protectedIds
      ? { protectedIds: [...thread.configCheck.protectedIds] }
      : {}),
    recordedModel: thread.recordedModel,
  };
}
