import { applyConfigCheck } from "./config_check";
import { replacePermissionEffect } from "./permission_effect";
import { pauseQueue } from "./queue";
import { sessionOperations } from "./session_fork_types";
import { workspaceAccessCapability } from "./workspace_access_types";
import { sessionToolInventoryCapability } from "./session_tools_types";
import {
  forgetSessionIdentity,
  identityReadSupport,
} from "./session_identity_types";
import type { OpenInput } from "./session_open_input";
import { draftGroup } from "./session_open_input";
import type { OpenResult } from "./session_open_types";
import {
  freshThreadState,
  normalizeConfigOptions,
  synthesizeModeOption,
} from "./session_projection";
import type { ThreadState } from "./session_types";
import { STRINGS } from "./strings";

/** Shared projection for an acknowledged open or official copied-session load.
 * History is still delivered through its own checked channel, never cloned. */
export function openedThreadState(
  input: OpenInput,
  result: OpenResult,
  savedTitle: string | null | undefined,
  existing?: ThreadState,
  restoreQueue?: (state: ThreadState) => void,
): ThreadState {
  const key = `${input.agentId}:${result.cwd}:${result.nativeSessionId}`;
  const state = freshThreadState(
    key,
    input.agentId,
    result.cwd,
    result.nativeSessionId,
  );
  inheritOpeningWork(state, existing, restoreQueue);
  applyOpeningResult(state, input, result, savedTitle, existing?.title);
  return state;
}

/** Existing work ownership is separate from the returned configuration. A
 * private opener copies its queue container before any historical reducer. */
export function inheritOpeningWork(
  state: ThreadState,
  existing?: ThreadState,
  restoreQueue?: (state: ThreadState) => void,
): void {
  if (existing) {
    state.queued = existing.queued;
    state.queuePaused = existing.queuePaused ?? "unavailable";
    state.uncertainPrompt = existing.uncertainPrompt;
    state.stopUnconfirmed = existing.stopUnconfirmed;
    state.connectionOutcomeUnknown = existing.connectionOutcomeUnknown;
    state.historicalOutcomeUnknown = existing.historicalOutcomeUnknown;
    state.workEnabled = existing.workEnabled;
    state.forkOperation = existing.forkOperation;
  } else restoreQueue?.(state);
}

/** Install only the opening baseline on the supplied view. Callers preparing
 * history preserve and merge the finite later metadata effects themselves. */
export function applyOpeningResult(
  state: ThreadState,
  input: OpenInput,
  result: OpenResult,
  savedTitle: string | null | undefined,
  previousTitle?: string | null,
): void {
  forgetSessionIdentity(state);
  state.key = `${input.agentId}:${result.cwd}:${result.nativeSessionId}`;
  state.agentId = input.agentId;
  state.cwd = result.cwd;
  state.nativeSessionId = result.nativeSessionId;
  state.service = result.service ?? undefined;
  state.serviceContext = result.serviceContext ?? undefined;
  state.serviceModelValue = result.serviceModelValue;
  state.connectionId = result.connectionId;
  state.sessionOperations = sessionOperations(result.sessionOperations);
  state.workspaceAccess = workspaceAccessCapability(result.workspaceAccess);
  state.identityRead = identityReadSupport(result.identityRead);
  state.sessionToolInventory = sessionToolInventoryCapability(
    result.sessionToolInventory,
  );
  state.draftGroup = draftGroup(input);
  state.resumed = result.resumed;
  state.identity = result.resumed ? "established" : "draft";
  state.title = savedTitle?.trim() ? savedTitle : (previousTitle ?? null);
  state.configOptions = normalizeConfigOptions(result.configOptions);
  state.currentModeId = null;
  state.modesSeparate = false;
  state.configCheck = null;
  state.modelDrift = false;
  state.configError = null;
  state.permissionConfigId = result.permissionConfigId;
  replacePermissionEffect(state, result.permissionEffect);
  state.permissionState = result.permissionConfigId
    ? result.resumed
      ? "required"
      : (result.permissionState ?? "unknown")
    : "ready";
  if (state.permissionConfigId && state.permissionState !== "ready")
    pauseQueue(state, state.uncertainPrompt ? "uncertain" : "stopped");
  const modeOption = synthesizeModeOption(
    result.modes,
    result.configOptionsModern ?? Array.isArray(result.configOptions),
  );
  if (
    modeOption &&
    !state.configOptions.some((o) => o.id === "mode" || o.category === "mode")
  ) {
    state.modesSeparate = true;
    state.configOptions = [...state.configOptions, modeOption];
    if (typeof modeOption.currentValue === "string")
      state.currentModeId = modeOption.currentValue;
  }
  if (result.configCheck) applyConfigCheck(state, result.configCheck);
  if (result.warnings?.length && result.configCheck?.status !== "ready")
    state.configError = STRINGS.repair.recheckConfigFailed;
}
