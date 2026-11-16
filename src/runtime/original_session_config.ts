import { invoke } from "@tauri-apps/api/core";
import {
  configurationInputBusy,
  sameConfigurationSnapshot,
} from "./config_check";
import { configChangeBusy } from "./protected_config";
import { captureConfigurationOwner } from "./saved_configuration_restore";
import type { ThreadState } from "./session_types";

interface OriginalConfigChoice {
  id: string;
  name: string;
  value: string;
  label: string;
}

export interface OriginalConfigReview {
  reviewId: string;
  source: "attestation" | "backup";
  choices: OriginalConfigChoice[];
}

export function originalSessionConfigTarget(thread: ThreadState) {
  const { agentId, cwd, nativeSessionId: sessionId, connectionId } = thread;
  const check = thread.configCheck;
  if (
    thread.identity !== "established" ||
    !thread.resumed ||
    !sessionId ||
    !connectionId ||
    thread.service ||
    thread.unrecoverable ||
    thread.historyUnavailable ||
    check?.status !== "blocked" ||
    !check.issues.length ||
    check.issues.some(
      ({ reason, current }) => reason !== "unrecorded" || current === null,
    ) ||
    !thread.items.some(
      (item) =>
        (item.kind === "user" || item.kind === "agent") &&
        (item.text.trim() || item.attachments?.length),
    )
  )
    return null;
  return { agentId, cwd, sessionId, connectionId };
}

export function originalSessionConfigBusy(thread: ThreadState): boolean {
  return (
    configChangeBusy(thread) ||
    thread.historicalOutcomeUnknown === true ||
    thread.permissionState !== "ready" ||
    configurationInputBusy(thread)
  );
}

export async function reviewOriginalSessionConfig(
  thread: ThreadState,
  ownsView: () => boolean,
  backupPath?: string,
): Promise<OriginalConfigReview | null> {
  const target = originalSessionConfigTarget(thread);
  if (!target || originalSessionConfigBusy(thread) || !ownsView()) return null;
  const sameOwner = captureConfigurationOwner(thread);
  const displayed = structuredClone(thread.configCheck);
  const result = await invoke<OriginalConfigReview>(
    "acp_review_original_session_config",
    { ...target, ...(backupPath === undefined ? {} : { backupPath }) },
  );
  if (
    !ownsView() ||
    !sameOwner() ||
    originalSessionConfigBusy(thread) ||
    !sameConfigurationSnapshot(displayed, thread.configCheck)
  )
    return null;
  if (
    !result?.reviewId ||
    typeof result.reviewId !== "string" ||
    result.source !== (backupPath === undefined ? "attestation" : "backup") ||
    !Array.isArray(result.choices) ||
    !result.choices.length ||
    new Set(result.choices.map((choice) => choice?.id)).size !==
      result.choices.length ||
    result.choices.some((choice) =>
      ["id", "name", "value", "label"].some((field) => {
        const value = choice?.[field as keyof OriginalConfigChoice];
        return typeof value !== "string" || !value.trim();
      }),
    ) ||
    !sameConfigurationSnapshot(
      result.choices.map(({ id, value }) => ({ id, value })),
      reviewedValues(thread, result.choices),
    )
  )
    throw new Error("Invalid original configuration review");
  return result;
}

function reviewedValues(thread: ThreadState, choices: OriginalConfigChoice[]) {
  const snapshot = thread.configCheck?.current as
    | {
        choices?: { id: string; value: string }[];
      }
    | undefined;
  if (
    !Array.isArray(snapshot?.choices) ||
    snapshot.choices.length !== choices.length
  )
    return null;
  const live = new Map(snapshot.choices.map(({ id, value }) => [id, value]));
  return choices.map(({ id }) => ({ id, value: live.get(id) }));
}
