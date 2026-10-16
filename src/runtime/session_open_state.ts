import { applyConfigCheck } from "./config_check";
import { replacePermissionEffect } from "./permission_effect";
import { pauseQueue } from "./queue";
import { sessionOperations } from "./session_fork_types";
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
  state.service = result.service ?? undefined;
  state.serviceContext = result.serviceContext ?? undefined;
  state.connectionId = result.connectionId;
  state.sessionOperations = sessionOperations(result.sessionOperations);
  state.draftGroup = draftGroup(input);
  state.resumed = result.resumed;
  state.identity = result.resumed ? "established" : "draft";
  if (existing) {
    state.queued = existing.queued;
    state.queuePaused = existing.queuePaused ?? "unavailable";
    state.uncertainPrompt = existing.uncertainPrompt;
    state.stopUnconfirmed = existing.stopUnconfirmed;
    state.connectionOutcomeUnknown = existing.connectionOutcomeUnknown;
    state.workEnabled = existing.workEnabled;
    state.forkOperation = existing.forkOperation;
  } else restoreQueue?.(state);
  state.title = savedTitle?.trim() ? savedTitle : (existing?.title ?? null);
  state.configOptions = normalizeConfigOptions(result.configOptions);
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
  return state;
}
