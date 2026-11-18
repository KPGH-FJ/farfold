import {
  receiveToolMedia,
  rememberToolMediaSource,
} from "./session_tool_media";
import { invoke } from "@tauri-apps/api/core";
import { threadProgramAuthentication } from "./authentication";
import { observeDesktopNotification } from "./desktop_notifications";
import { appendToolOutput } from "./artifacts";
import { receiveFileInput } from "./tool_file_input";
import { applyConfigCheck, type ConfigCheck } from "./config_check";
import { receiveAsyncTasks } from "./async_tasks";
import { receiveWorkActivity } from "./session_work_activity";
import { receiveProgramStatus } from "./program_status";
import { receiveMessageUsage } from "./message_usage";
import { hasActiveFork, receiveForkActivity } from "./session_fork_activity";
import { replacePermissionEffect } from "./permission_effect";
import { retainReportedDetails } from "./reported_details";
import { hasOwnUpdate, isHistoryMarkerShape } from "./session_open_replay";
import { conversationReadState } from "./conversation_read_state";
import { pauseQueue, removeQueued } from "./queue";
import { STRINGS } from "./strings";
import { forgetSessionIdentity } from "./session_identity_types";
import { receiveSessionUsage } from "./session_usage_notification";
import type { ThreadState, ToolContent } from "./session_types";
import type { PromptRequestOwner } from "./prompt_admission";
import {
  applyUpdate,
  applyTurnEnd,
  applyConnectionLost,
  applyPermissionRequest,
  withdrawReportedPermissionInput,
  normalizeConfigOptions,
  replaceConfigOptions,
  clearPendingRequests,
  expirePendingRequest,
  completeElicitation,
  applyElicitation,
  pushRaw,
  pushNotification,
  isKnownConfigUpdate,
} from "./session_projection";

export interface SessionEventEffects {
  owns(): boolean;
  promptOwner(): PromptRequestOwner | undefined;
  configurationChanging(): boolean;
  configurationOptionsReceived?(): void;
  receiveConfigCheck(check: ConfigCheck): boolean;
  finishActivity(): void;
  permissionChanged(): void;
  clearStop(): void;
  closeChannel(): void;
  emit(): void;
  drain(): void;
  refresh(): void;
  schedule(): void;
}

/** One event reducer for private historical projection and the published view.
 * Only an installed view receives effects; hidden work never emits, writes
 * metadata, sends queued input or creates external execution authority. */
export function applySessionEvent(
  s: ThreadState,
  event: unknown,
  live: boolean,
  effects?: SessionEventEffects,
  activityConnectionId?: string,
): void {
  const media = receiveToolMedia(s, event, effects?.owns, activityConnectionId);
  if (media) {
    if (live && effects?.owns()) {
      conversationReadState.receiveToolMedia(
        s.key,
        media.priorReadableContent,
        media.call.content,
      );
      effects.emit();
    }
    return;
  }
  if (!event || typeof event !== "object") return;
  const e = event as Record<string, unknown>;
  if (
    [
      "toolMedia",
      "historyToolSupplement",
      "historyToolSupplementStatus",
    ].includes(String(e.kind)) &&
    !hasOwnUpdate(e)
  ) {
    pushRaw(s, e);
    effects?.emit();
    return;
  }
  if (receiveSessionUsage(s, e, effects?.owns, activityConnectionId)) {
    if (live && effects?.owns()) effects.emit();
    return;
  }
  // Recognized live-only hints cannot be smuggled into history by an own
  // `update` field. The original envelope has already traversed the event bus.
  if (receiveProgramStatus(s, e, live, effects?.owns, activityConnectionId)) {
    if (live && effects?.owns()) effects.emit();
    return;
  }
  if (receiveMessageUsage(s, e, effects?.owns, activityConnectionId)) {
    if (live && effects?.owns()) effects.emit();
    return;
  }
  const updateEnvelope = hasOwnUpdate(e);
  const kind = updateEnvelope ? undefined : e.kind;
  if (kind === "ownedTerminalExit") {
    if (Object.hasOwn(e, "sessionId")) {
      pushRaw(s, e);
      effects?.emit();
    } else if (
      live &&
      effects?.owns() &&
      (activityConnectionId === undefined ||
        activityConnectionId === s.connectionId) &&
      receiveOwnedTerminalExit(s, e)
    )
      effects.emit();
    return;
  }
  const endingOwner = kind === "turnEnd" ? effects?.promptOwner() : undefined;
  // Validate before projection can treat work evidence as ours.
  // Unknown Agent envelopes and foreign receipts remain raw observations.
  if (
    ((kind === "turnEnd" || kind === "toolActivity") &&
      Object.hasOwn(e, "sessionId")) ||
    (kind === "turnEnd" &&
      endingOwner &&
      !endingOwner.ending(e.promptReceiptId))
  ) {
    pushRaw(s, e);
    effects?.emit();
    return;
  }
  if (effects)
    observeDesktopNotification(s, updateEnvelope ? {} : e, live, effects.owns);
  if (kind === "configOptions") {
    effects?.configurationOptionsReceived?.();
    if (!effects?.configurationChanging())
      replaceConfigOptions(
        s,
        normalizeConfigOptions(e.options),
        e.modern !== false,
      );
  } else if (kind === "configCheck") {
    if ((e.check as ConfigCheck | undefined)?.status !== "ready")
      forgetSessionIdentity(s);
    if (!effects?.receiveConfigCheck(e.check as ConfigCheck))
      applyConfigCheck(s, e.check as ConfigCheck);
  } else if (kind === "asyncTasks") {
    if (!receiveAsyncTasks(s, e)) return;
    effects?.finishActivity();
  } else if (kind === "forkActivity") {
    if (!receiveForkActivity(s, e)) return;
  } else if (
    !updateEnvelope &&
    receiveWorkActivity(s, e, activityConnectionId)
  ) {
    effects?.finishActivity();
  } else if (kind === "permissionState") {
    // Only the explicit setter's matching reply may enable sending. A late
    // event can report state, but never undo an unknown result locally.
    if (typeof e.permissionConfigId === "string")
      s.permissionConfigId = e.permissionConfigId;
    replacePermissionEffect(s, e.permissionEffect);
    if (e.permissionState === "unknown" || e.permissionState === "required") {
      effects?.permissionChanged();
      s.permissionState = e.permissionState;
      pauseQueue(s, s.uncertainPrompt ? "uncertain" : "stopped");
    }
  } else if (kind === "permissionRequest") {
    applyPermissionRequest(s, {
      requestId: String(e.requestId ?? ""),
      toolCall: e.toolCall,
      options: e.options,
      request: e.request,
      reportedToolInput: e.reportedToolInput,
      terminalCommand: e.terminalCommand,
    });
  } else if (kind === "turnEnd") {
    const owner = endingOwner;
    if (!s.running && !s.uncertainPrompt && !s.connectionOutcomeUnknown) return;
    effects?.clearStop();
    if (s.uncertainPrompt) {
      removeQueued(s, s.uncertainPrompt);
      s.uncertainPrompt = null;
    }
    const result = applyTurnEnd(s, {
      stopReason: typeof e.stopReason === "string" ? e.stopReason : undefined,
      error: typeof e.error === "string" ? e.error : undefined,
      failure: e.failure,
      usage: e.usage,
      failedWorkCloseAvailable:
        live && owner && e.failedWorkCloseAvailable === true ? true : undefined,
    });
    if (owner) {
      if (
        [
          "end_turn",
          "max_tokens",
          "max_turn_requests",
          "refusal",
          "cancelled",
        ].includes(String(e.stopReason))
      ) {
        // A known terminal reason confirms delivery before IPC settles.
        owner.confirmDelivery();
        owner.end();
      } else {
        s.connectionOutcomeUnknown = true;
        pauseQueue(s, "uncertain");
      }
    }
    if (effects && e.error === "AUTH_REQUIRED")
      threadProgramAuthentication(s)?.observe(
        s.cwd,
        e.error,
        s.serviceContext,
        "request",
      );
    else if (
      effects &&
      !e.error &&
      !e.failure &&
      e.stopReason === "end_turn" &&
      (result === "reply" || result === "tool")
    )
      threadProgramAuthentication(s)?.observe(
        s.cwd,
        undefined,
        s.serviceContext,
        "request",
      );
    effects?.emit();
    effects?.finishActivity();
    effects?.drain();
    effects?.refresh();
    return;
  } else if (kind === "serviceUnavailable" || kind === "deliveryUnavailable") {
    forgetSessionIdentity(s);
    s.sourceError = true;
    s.openError =
      typeof e.message === "string"
        ? e.message
        : kind === "deliveryUnavailable"
          ? STRINGS.repair.deliveryInterrupted
          : STRINGS.repair.requestFailed;
    pauseQueue(s, "unavailable");
  } else if (kind === "connectionLost") {
    if (hasActiveFork(s) && s.forkOperation) s.forkOperation.status = "unknown";
    replacePermissionEffect(s, undefined);
    effects?.clearStop();
    effects?.promptOwner()?.end();
    applyConnectionLost(s, e.closeReason);
    effects?.closeChannel();
    pauseQueue(s, s.uncertainPrompt ? "uncertain" : "unavailable");
  } else if (kind === "interactionsCancelled") {
    clearPendingRequests(s);
  } else if (kind === "interactionExpired") {
    expirePendingRequest(s, String(e.requestId ?? ""));
  } else if (kind === "elicitationUnavailable") {
    pushRaw(s, e.params, STRINGS.repair.unsupportedInquiry);
    pauseQueue(s, "unavailable");
  } else if (kind === "elicitationComplete") {
    completeElicitation(s, e);
  } else if (kind === "elicitation") {
    applyElicitation(s, e);
  } else if (kind === "toolOutput") {
    if (appendToolOutput(s, e))
      withdrawReportedPermissionInput(s, e.toolCallId);
  } else if (kind === "toolFileInput") {
    receiveFileInput(s, e);
  } else if (kind === "notification") {
    pushNotification(s, { method: e.method, params: e.params });
  } else if (kind === "session_history_complete") {
    if (!isHistoryMarkerShape(e)) pushRaw(s, e);
  } else if (updateEnvelope || e.update !== undefined) {
    if (
      [
        "config_option_update",
        "current_model_update",
        "current_mode_update",
      ].includes(
        String((e.update as { sessionUpdate?: unknown } | null)?.sessionUpdate),
      )
    )
      effects?.configurationOptionsReceived?.();
    if (
      (e.update as { sessionUpdate?: unknown } | null)?.sessionUpdate ===
      "config_option_update"
    ) {
      if (!isKnownConfigUpdate(e.update))
        pushRaw(s, e.update, "config_option_update");
      retainReportedDetails(s, e.update, e);
      effects?.emit();
      return;
    }
    const updateCallId = (e.update as { toolCallId?: unknown } | null)
      ?.toolCallId;
    const previousTool =
      typeof updateCallId === "string"
        ? s.items.find(
            (item) =>
              item.kind === "tool" && item.call.toolCallId === updateCallId,
          )
        : undefined;
    const previousContent: readonly ToolContent[] =
      previousTool?.kind === "tool" ? previousTool.call.content : [];
    try {
      const call = applyUpdate(s, e.update, e);
      rememberToolMediaSource(
        s,
        e,
        call,
        effects?.owns,
        activityConnectionId,
        previousContent,
      );
      if (
        call &&
        live &&
        effects?.owns() &&
        e.sessionId === s.nativeSessionId &&
        !s.connectionLost &&
        (activityConnectionId === undefined ||
          activityConnectionId === s.connectionId)
      )
        conversationReadState.receiveToolMedia(
          s.key,
          previousContent,
          call.content,
        );
    } catch (error) {
      // A local conversion of ordinary Agent JSON must not strand Tauri's
      // ordered Channel index. Keep the entire envelope as opaque data.
      // History preparation still fails at its original transaction boundary;
      // no working/unknown/receipt/permission owner is retired by this fallback.
      if (!live || !(error instanceof TypeError)) throw error;
      pushRaw(s, e);
      effects?.emit();
      return;
    }
    if (effects && live) conversationReadState.receiveUpdate(s.key, e.update);
    if (
      (e.update as { sessionUpdate?: unknown } | undefined)?.sessionUpdate ===
      "tool_call_update"
    )
      effects?.finishActivity();
    const update = e.update as {
      sessionUpdate?: unknown;
      content?: { type?: unknown; text?: unknown };
    } | null;
    if (
      [
        "user_message_chunk",
        "agent_message_chunk",
        "agent_thought_chunk",
      ].includes(String(update?.sessionUpdate)) &&
      update?.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      effects?.schedule();
      return;
    }
    if (effects) flushSessionMetadata(s, effects.refresh);
  }
  effects?.emit();
}

function receiveOwnedTerminalExit(
  thread: ThreadState,
  event: Record<string, unknown>,
): boolean {
  const stop = thread.ownedTerminalStop;
  const terminalId = event.terminalId;
  if (
    !stop ||
    thread.connectionLost ||
    thread.connectionId !== stop.connectionId ||
    event.promptReceiptId !== stop.promptReceiptId ||
    typeof terminalId !== "string" ||
    !terminalId ||
    (Object.hasOwn(event, "exitCode") &&
      !Number.isSafeInteger(event.exitCode)) ||
    (Object.hasOwn(event, "signal") && !Number.isSafeInteger(event.signal)) ||
    stop.terminalIds.has(terminalId)
  )
    return false;
  if (stop.settledId) {
    const item = thread.items.find(({ id }) => id === stop.settledId);
    if (item?.kind !== "settled") return false;
    item.ownedTerminalExitCount = stop.terminalIds.size + 1;
  }
  stop.terminalIds.add(terminalId);
  return true;
}

/** One metadata write after the accepted view has an actual live owner. */
export function flushSessionMetadata(
  s: ThreadState,
  refresh: () => void,
): void {
  if (!s.metaDirty) return;
  s.metaDirty = false;
  void invoke("session_touch", {
    agentId: s.agentId,
    cwd: s.cwd,
    sessionId: s.nativeSessionId,
    title: s.title,
    configOptions: null,
  })
    .then(refresh)
    .catch(() => undefined);
}
