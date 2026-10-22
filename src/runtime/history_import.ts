import { SessionDeliveryObserver } from "./session_delivery_observer";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  applyUpdate,
  freshThreadState,
  normalizeConfigOptions,
  replaceConfigOptions,
  pushRaw,
} from "./session_projection";
import { applyConfigCheck, configCheckMessage } from "./config_check";
import type { ThreadState } from "./session_types";
import type { IndexRow, OpenResult } from "./sessions";
import { IMPORT_STRINGS as S } from "./import_strings";
import { hasReadableMessages } from "./message_attachments";
import { HistoryReplayBuffer, finishHistoryPrefix } from "./history_replay";
import { historyReads } from "./session_history_admission";
import { consumeHistoryEvents } from "./history_replay_work";

export interface DiscoveredConversation {
  nativeSessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: number | null;
  canLoad: boolean;
  locationAvailable: boolean;
  alreadyAddedId: string | null;
  isOpen: boolean;
}
export interface DiscoveryPage {
  status: "supported" | "unsupported";
  sessions: DiscoveredConversation[];
  nextCursor: string | null;
}
export interface HistoryPreview {
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  previewToken: string;
  replayComplete: boolean;
  state: ThreadState;
  warnings?: string[];
}
export async function discoverHistory(
  agentId: string,
  cursor?: string,
  cwd?: string | null,
): Promise<DiscoveryPage> {
  return invoke("session_discover", {
    agentId,
    cursor: cursor ?? null,
    ...(cwd ? { connectionCwd: cwd, cwd } : {}),
  });
}
export async function previewHistory(
  agentId: string,
  row: DiscoveredConversation,
): Promise<HistoryPreview> {
  const state = freshThreadState(
    "preview",
    agentId,
    row.cwd,
    row.nativeSessionId,
  );
  const openToken = crypto.randomUUID();
  const readKey = `preview:${openToken}`;
  const admission = historyReads.begin(
    readKey,
    { agentId, cwd: row.cwd, nativeSessionId: row.nativeSessionId },
    openToken,
    "preview",
  );
  const delivery = new SessionDeliveryObserver(agentId, openToken);
  const channel = new Channel<unknown>();
  const buffered = new HistoryReplayBuffer();
  let previewToken: string | null = null;
  let completeReplay: (() => void) | undefined;
  let receiving = true;
  channel.onmessage = (input) =>
    delivery.receive(input, (event) => {
      if (!receiving || !event || typeof event !== "object") return "discarded";
      if (
        "kind" in event &&
        event.kind === "history_preview_complete" &&
        "previewToken" in event &&
        typeof event.previewToken === "string"
      ) {
        buffered.mark(event.previewToken);
        if (previewToken === event.previewToken) completeReplay?.();
        return "consumed";
      } else {
        admission?.observeRaw();
        buffered.push(event);
        return "buffered";
      }
    });
  try {
    admission?.dispatch();
    const result = await invoke<OpenResult & { previewToken: string }>(
      "session_import_preview",
      {
        agentId,
        cwd: row.cwd,
        sessionId: row.nativeSessionId,
        openToken,
        admissionChannel: admission?.channel,
        channel,
      },
    );
    // A successful invoke has granted one exact cleanup receipt. Preserve it
    // even if either synchronous renderer conversion below fails locally.
    const owned: HistoryPreview = {
      ...result,
      agentId,
      state,
      replayComplete: false,
    };
    previewToken = result.previewToken;
    try {
      state.cwd = result.cwd;
      state.connectionId = result.connectionId;
      state.nativeSessionId = result.nativeSessionId;
      state.resumed = true;
      state.identity = "established";
      state.service = result.service ?? undefined;
      state.serviceContext = result.serviceContext ?? undefined;
      state.configOptions = normalizeConfigOptions(result.configOptions);
      state.permissionConfigId = result.permissionConfigId;
      state.permissionState = result.permissionConfigId ? "required" : "ready";
      if (result.configCheck) applyConfigCheck(state, result.configCheck);
    } catch {
      // This catch covers only local synchronous metadata projection, never
      // invoke/auth failure. The caller receives an ineligible cleanup owner.
      state.openError = S.loadFailed;
      return owned;
    }
    // Invoke and Channel delivery are independent. Only this ordered channel's
    // matching marker proves the renderer has consumed the replay prefix.
    const replayComplete =
      buffered.complete(previewToken) ||
      (await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 30_000);
        completeReplay = () => {
          clearTimeout(timer);
          resolve(true);
        };
      }));
    // A preview is a read-only snapshot of the acknowledged load prefix.
    // Traffic received after that boundary cannot make empty history readable.
    try {
      await consumeHistoryEvents(buffered.prefixEvents(previewToken), (event) =>
        delivery.consumeBuffered(() => {
          if (!event || typeof event !== "object") return;
          if (
            "kind" in event &&
            event.kind === "configOptions" &&
            "options" in event
          ) {
            replaceConfigOptions(
              state,
              normalizeConfigOptions(event.options),
              !("modern" in event && event.modern === false),
            );
          } else if ("update" in event) {
            if (
              (event.update as { sessionUpdate?: unknown } | null)
                ?.sessionUpdate === "config_option_update"
            )
              pushRaw(state, event.update, "config_option_update");
            else applyUpdate(state, event.update, event);
          }
        }),
      );
      finishHistoryPrefix(state);
    } catch {
      // An acknowledged native preview is not a successful displayed body.
      // Retain the exact receipt; the existing false flag denies commit and
      // lets the caller retry an unconfirmed exact close without another load.
      state.openError = S.loadFailed;
      return owned;
    }
    // A delivery timeout keeps ownership available for the caller to close or
    // retry. Partial text is never eligible for display or admission.
    return { ...owned, replayComplete };
  } finally {
    receiving = false;
    delivery.dispose();
    channel.onmessage = () => {};
    buffered.clear();
    historyReads.finish(readKey, admission);
  }
}
export function hasPreviewContent(preview: HistoryPreview): boolean {
  return preview.replayComplete && hasReadableMessages(preview.state.items);
}
/** Preview evidence is separate from permission to send after a later open. */
export function historyContinuation(preview: HistoryPreview): {
  title: string;
  detail: string;
} {
  if (!hasPreviewContent(preview))
    return { title: S.bodyUnavailable, detail: S.noContent };
  const check = preview.state.configCheck;
  if (!check)
    return { title: S.continuationUnknown, detail: S.originalUnknown };
  if (check.status !== "ready")
    return {
      title:
        check.status === "confirmation_required"
          ? S.confirmOriginal
          : S.readOnlyTitle,
      detail:
        configCheckMessage(check, preview.state.configOptions) ??
        S.originalUnknown,
    };
  if (preview.state.permissionConfigId)
    return { title: S.permissionRequired, detail: S.permissionHint };
  return { title: S.originalVerified, detail: S.recheckOnOpen };
}
export function closeHistoryPreview(preview: HistoryPreview): Promise<void> {
  return invoke("session_import_close", {
    agentId: preview.agentId,
    cwd: preview.cwd,
    sessionId: preview.nativeSessionId,
    previewToken: preview.previewToken,
  });
}
export function commitHistoryPreview(
  preview: HistoryPreview,
  title: string | null,
): Promise<IndexRow> {
  if (!preview.replayComplete) return Promise.reject(new Error(S.loadFailed));
  if (!hasPreviewContent(preview))
    return Promise.reject(new Error(S.noContent));
  return invoke("session_import_commit", {
    agentId: preview.agentId,
    cwd: preview.cwd,
    sessionId: preview.nativeSessionId,
    previewToken: preview.previewToken,
    title,
  });
}
