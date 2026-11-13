import {
  receiveToolMedia,
  rememberToolMediaSource,
} from "./session_tool_media";
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
import { HistoryReplayProjection } from "./history_replay_projection";
import { historyReads } from "./session_history_admission";
import { openingInquiries } from "./opening_inquiries";
import {
  forgetSessionIdentity,
  identityReadSupport,
} from "./session_identity_types";
import type { OpenInput } from "./session_open_input";

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
export type HistoryPreviewTarget = Pick<
  DiscoveredConversation,
  "nativeSessionId" | "cwd"
>;
export type HistoryPreviewCleanup = Pick<
  HistoryPreview,
  "agentId" | "cwd" | "nativeSessionId" | "previewToken"
>;
export interface DiscoveryPage {
  status: "supported" | "unsupported";
  sessions: DiscoveredConversation[];
  nextCursor: string | null;
}
export type HistoryPreviewPurpose = "importPreview" | "searchReadOnly";
export type HistoryPreviewInterest = Pick<
  OpenInput,
  "inquiryCurrent" | "inquirySignal"
>;
export interface HistoryPreview {
  readonly purpose: HistoryPreviewPurpose | null;
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
  interest?: HistoryPreviewInterest,
): Promise<HistoryPreview> {
  return loadHistoryPreview(agentId, row, "importPreview", interest);
}
export async function readHistoryPreview(
  agentId: string,
  row: HistoryPreviewTarget,
  interest?: HistoryPreviewInterest,
): Promise<HistoryPreview> {
  return loadHistoryPreview(agentId, row, "searchReadOnly", interest);
}
async function loadHistoryPreview(
  agentId: string,
  row: HistoryPreviewTarget,
  purpose: HistoryPreviewPurpose,
  interest?: HistoryPreviewInterest,
): Promise<HistoryPreview> {
  let interested = true;
  const current = () => {
    if (!interested) return false;
    try {
      interested =
        !interest?.inquirySignal?.aborted &&
        (interest?.inquiryCurrent?.() ?? true);
    } catch {
      interested = false;
    }
    return interested;
  };
  if (!current()) throw new Error(S.loadFailed);
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
    {
      agentId,
      cwd: row.cwd,
      nativeSessionId: row.nativeSessionId,
      inquiryCurrent: current,
      inquirySignal: interest?.inquirySignal,
    },
    openToken,
    "preview",
  );
  const delivery = new SessionDeliveryObserver(agentId, openToken);
  const channel = new Channel<unknown>();
  let previewToken: string | null = null;
  let markedPreviewToken: string | null = null;
  let configOptionsSeen = false;
  let completeReplay: ((complete: boolean) => void) | undefined;
  let receiving = true;
  let deliveryFailed = false;
  type MediaOpening = Pick<
    OpenResult,
    "cwd" | "nativeSessionId" | "connectionId"
  >;
  let mediaOpening: MediaOpening | undefined;
  let resultOwner: MediaOpening | undefined;
  let mediaOwnerConflict = false;
  const sameMediaOwner = (owner: MediaOpening) =>
    !mediaOpening ||
    (mediaOpening.cwd === owner.cwd &&
      mediaOpening.nativeSessionId === owner.nativeSessionId &&
      mediaOpening.connectionId === owner.connectionId);
  // This is only the current private preview, never an installed live view.
  const mediaCurrent = () =>
    receiving &&
    current() &&
    !projected.complete &&
    !deliveryFailed &&
    !!mediaOpening &&
    !mediaOwnerConflict;

  const retire = () => {
    interested = false;
    completeReplay?.(false);
  };
  interest?.inquirySignal?.addEventListener("abort", retire, { once: true });
  const projected = new HistoryReplayProjection(
    state,
    openToken,
    (target, event) => {
      if (!event || typeof event !== "object") return;
      if (
        !Object.hasOwn(event, "update") &&
        "kind" in event &&
        event.kind === "configOptions" &&
        "options" in event
      ) {
        replaceConfigOptions(
          target,
          normalizeConfigOptions(event.options),
          !("modern" in event && event.modern === false),
        );
        configOptionsSeen = true;
      } else if ("update" in event) {
        if (
          (event.update as { sessionUpdate?: unknown } | null)
            ?.sessionUpdate === "config_option_update"
        )
          pushRaw(target, event.update, "config_option_update");
        else {
          const call = applyUpdate(target, event.update, event);
          if (mediaCurrent())
            rememberToolMediaSource(
              target,
              event as Record<string, unknown>,
              call,
              mediaCurrent,
              mediaOpening?.connectionId,
            );
        }
      } else if ("kind" in event && event.kind === "toolMedia") {
        // A rejected supplement stays inspectable, without adding an attachment.
        pushRaw(target, event);
      }
    },
    () => receiving && current(),
  );
  const inquiry = openingInquiries.begin(readKey, {
    agentId,
    cwd: row.cwd,
    inquiryCurrent: () => receiving && current(),
    inquirySignal: interest?.inquirySignal,
    inquiryPermissions: "cancel",
  });
  channel.onmessage = (input) =>
    delivery.receive(input, (event) => {
      // Controls intercepted below also break adjacency. No source body is
      // retained and no late marker/permission event can leave a reusable slot.
      const mediaReceived = receiveToolMedia(
        state,
        event,
        mediaCurrent,
        mediaOpening?.connectionId,
      );
      if (!receiving || !event || typeof event !== "object") return "discarded";
      if (mediaReceived) return "consumed";
      // Control-shaped fields inside a raw Agent update are not client control.
      const control = !Object.hasOwn(event, "update");
      if (control && inquiry.receive(event)) return "consumed";
      if (!current()) {
        completeReplay?.(false);
        return "discarded";
      }
      if (control && "kind" in event && event.kind === "sessionOpening") {
        if (projected.complete) return "discarded";
        // This request already knows its history ID. The native opening header
        // is local coordination only, never body/configuration or another owner.
        if (!(
          Object.keys(event).length === 5 &&
          "openToken" in event &&
          event.openToken === openToken &&
          "sessionId" in event &&
          event.sessionId === row.nativeSessionId &&
          "connectionId" in event &&
          typeof event.connectionId === "string" &&
          !!event.connectionId &&
          "cwd" in event &&
          typeof event.cwd === "string" &&
          !!event.cwd
        ))
          return "discarded";
        const owner = {
          cwd: event.cwd,
          nativeSessionId: event.sessionId,
          connectionId: event.connectionId,
        };
        if (!sameMediaOwner(owner)) mediaOwnerConflict = true;
        if (!mediaOpening) {
          mediaOpening = owner;
          if (resultOwner && !sameMediaOwner(resultOwner))
            mediaOwnerConflict = true;
          if (!mediaOwnerConflict) {
            state.cwd = owner.cwd;
            state.connectionId = owner.connectionId;
          }
        }
        return "consumed";
      }
      if (control && "kind" in event && event.kind === "deliveryUnavailable") {
        deliveryFailed = true;
        state.openError = S.loadFailed;
        completeReplay?.(false);
        return "consumed";
      }
      if (
        control &&
        "kind" in event &&
        event.kind === "history_preview_complete"
      ) {
        if (
          Object.keys(event).length !== 3 ||
          !("openToken" in event) ||
          event.openToken !== openToken ||
          !("previewToken" in event) ||
          typeof event.previewToken !== "string" ||
          !event.previewToken
        )
          return "discarded";
        // The first exact request marker seals this private snapshot even when
        // the invoke result has not arrived. Later traffic cannot mutate it.
        if (markedPreviewToken === null) {
          markedPreviewToken = event.previewToken;
          projected.mark(openToken);
        }
        if (previewToken !== null)
          completeReplay?.(previewToken === markedPreviewToken);
        return "consumed";
      }
      if (projected.complete) return "discarded";
      admission?.observeRaw();
      return projected.push(event);
    });
  try {
    admission?.dispatch();
    const result = await invoke<
      OpenResult & { previewToken: string; purpose: HistoryPreviewPurpose }
    >(
      purpose === "searchReadOnly"
        ? "session_read_preview"
        : "session_import_preview",
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
      purpose: result.purpose === purpose ? result.purpose : null,
      agentId,
      state,
      replayComplete: false,
    };
    const failed = (): HistoryPreview => {
      // Only the successful same private view is published. An incomplete or
      // failed prefix keeps its exact native cleanup receipt, not partial body.
      const unavailable = freshThreadState(
        "preview",
        agentId,
        result.cwd,
        result.nativeSessionId,
      );
      unavailable.openError = S.loadFailed;
      return { ...owned, state: unavailable };
    };
    previewToken = result.previewToken;
    resultOwner = result;
    if (
      owned.purpose !== purpose ||
      !current() ||
      mediaOwnerConflict ||
      !sameMediaOwner(result)
    )
      return failed();
    try {
      forgetSessionIdentity(state);
      state.cwd = result.cwd;
      state.connectionId = result.connectionId;
      state.nativeSessionId = result.nativeSessionId;
      state.resumed = true;
      state.identity = "established";
      state.service = result.service ?? undefined;
      state.serviceContext = result.serviceContext ?? undefined;
      state.identityRead = identityReadSupport(result.identityRead);
      const baseline = normalizeConfigOptions(result.configOptions);
      if (!configOptionsSeen) state.configOptions = baseline;
      state.permissionConfigId = result.permissionConfigId;
      state.permissionState = result.permissionConfigId ? "required" : "ready";
      if (result.configCheck) applyConfigCheck(state, result.configCheck);
    } catch {
      // This catch covers only local synchronous metadata projection, never
      // invoke/auth failure. The caller receives an ineligible cleanup owner.
      return failed();
    }
    // Invoke and Channel delivery are independent. Only this ordered channel's
    // matching marker proves the renderer has consumed the replay prefix.
    const replayComplete =
      !deliveryFailed &&
      (markedPreviewToken !== null
        ? markedPreviewToken === previewToken
        : await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 30_000);
            completeReplay = (complete) => {
              clearTimeout(timer);
              resolve(complete);
            };
          }));
    // A preview is a read-only snapshot of the acknowledged load prefix.
    // Traffic received after that boundary cannot make empty history readable.
    try {
      if (
        !current() ||
        !replayComplete ||
        markedPreviewToken !== previewToken ||
        mediaOwnerConflict ||
        !sameMediaOwner(result)
      )
        return failed();
      projected.requireComplete(agentId, result, deliveryFailed);
      projected.take();
    } catch {
      // An acknowledged native preview is not a successful displayed body.
      // Retain the exact receipt; the existing false flag denies commit and
      // lets the caller retry an unconfirmed exact close without another load.
      return failed();
    }
    // A delivery timeout keeps ownership available for the caller to close or
    // retry. Partial text is never eligible for display or admission.
    return { ...owned, replayComplete: replayComplete && !deliveryFailed };
  } finally {
    receiving = false;
    interest?.inquirySignal?.removeEventListener("abort", retire);
    inquiry.retire();
    delivery.dispose();
    channel.onmessage = () => {};
    projected.clear();
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
export function closeHistoryPreview(
  preview: HistoryPreviewCleanup,
): Promise<void> {
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
  if (preview.purpose !== "importPreview")
    return Promise.reject(new Error(S.loadFailed));
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
