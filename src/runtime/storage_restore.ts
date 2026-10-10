import { parseDraftSnapshot } from "./drafts";
import { parseSetupSnapshot } from "./setup_storage";
import { STORAGE_RESTORE_STRINGS as S } from "./storage_restore_strings";
import { storageIssueMessage, type StorageIssueKind } from "./storage_recovery";
export const RESTORE_KEYS = ["unsentWork.v1", "agentSetup.v1"] as const;
export type RestoreKey = (typeof RESTORE_KEYS)[number];
export type RestorePreview = {
  id: string;
  sourcePath: string;
  values: Record<RestoreKey, string | null>;
};
export type RestoreReceipt = {
  id: string;
  keys: RestoreKey[];
  protectedPath: string;
};
export type PreviewEntry = {
  key: RestoreKey;
  label: string;
  valid: boolean;
  summary: string;
  empty: boolean;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(S.unsupported);
  return value as Record<string, unknown>;
}
function known(value: unknown, keys: string[]): Record<string, unknown> {
  const item = object(value);
  if (Object.keys(item).some((key) => !keys.includes(key)))
    throw new Error(S.unsupported);
  return item;
}

export function checkedPreview(value: unknown): RestorePreview {
  const raw = object(value);
  if (
    typeof raw.id !== "string" ||
    !/^[a-f0-9]{48}$/.test(raw.id) ||
    typeof raw.sourcePath !== "string"
  )
    throw new Error(S.unknown);
  const values = known(raw.values, [...RESTORE_KEYS]);
  if (
    RESTORE_KEYS.some(
      (key) => values[key] !== null && typeof values[key] !== "string",
    )
  )
    throw new Error(S.unknown);
  return value as RestorePreview;
}
export function checkedReceipt(
  value: unknown,
  id: string,
  keys: readonly RestoreKey[],
): RestoreReceipt {
  const raw = object(value);
  if (
    raw.id !== id ||
    !Array.isArray(raw.keys) ||
    raw.keys.length !== keys.length ||
    new Set(raw.keys).size !== keys.length ||
    raw.keys.some((key) => !keys.includes(key)) ||
    typeof raw.protectedPath !== "string" ||
    !raw.protectedPath
  )
    throw new Error(S.unknown);
  return value as RestoreReceipt;
}
function strictChoice(value: unknown) {
  const choice = known(value, [
    "agentId",
    "cwd",
    "config",
    "service",
    "reviewRequired",
  ]);
  if (choice.service !== null)
    known(choice.service, ["id", "model", "revision"]);
}
function strictBlocks(value: unknown) {
  if (!Array.isArray(value)) throw new Error(S.unsupported);
  for (const block of value) {
    const b = object(block);
    if (b.type === "text") known(b, ["type", "text"]);
    else if (b.type === "image") known(b, ["type", "data", "mimeType", "uri"]);
    else if (b.type === "resource_link")
      known(b, ["type", "name", "uri", "mimeType"]);
    else if (b.type === "resource") {
      known(b, ["type", "resource"]);
      known(b.resource, ["uri", "mimeType", "text"]);
    } else throw new Error(S.unsupported);
  }
}

/** Normal legacy loading has its own compatibility rules. Recovery does not
 * guess the meaning of newer fields that could change pending/send behavior. */
function strictDraft(value: unknown) {
  if (value == null) return;
  const raw = object(value);
  strictChoice(raw.choice);
  for (const item of Object.values(object(raw.composers))) {
    const draft = known(item, [
      "text",
      "attachments",
      "sendPending",
      "queueEdit",
      "pendingConversation",
      "savedChoice",
    ]);
    if (draft.queueEdit !== undefined)
      strictBlocks(known(draft.queueEdit, ["index", "original"]).original);
    if (draft.savedChoice !== undefined) strictChoice(draft.savedChoice);
    if (!Array.isArray(draft.attachments)) throw new Error(S.unsupported);
    draft.attachments.forEach((item) =>
      known(item, ["id", "name", "kind", "uri", "data", "mimeType"]),
    );
    if (draft.pendingConversation !== undefined) {
      const pending = known(draft.pendingConversation, [
        "agentId",
        "cwd",
        "nativeSessionId",
        "service",
        "serviceRevision",
      ]);
      if (pending.service !== undefined)
        known(pending.service, ["id", "model"]);
    }
  }
  for (const queue of Object.values(object(raw.queues))) {
    const q = known(queue, ["blocks", "uncertainIndex"]);
    if (!Array.isArray(q.blocks)) throw new Error(S.unsupported);
    q.blocks.forEach(strictBlocks);
  }
  for (const items of Object.values(object(raw.feedback)))
    for (const item of Object.values(object(items))) {
      const feedback = known(item, [
        "path",
        "text",
        "selection",
        "lineInput",
        "contentId",
        "scope",
        "anchor",
      ]);
      if (feedback.selection !== null)
        known(feedback.selection, ["side", "line", "endLine"]);
      if (feedback.lineInput !== undefined)
        known(feedback.lineInput, ["side", "text"]);
    }
  if (raw.activity !== undefined)
    for (const activity of Object.values(object(raw.activity)))
      known(activity, ["lastActivityAt", "ended"]);
}
function strictSetup(value: unknown) {
  if (value == null) return;
  const raw = object(value);
  for (const item of Object.values(object(raw.progress))) {
    const entry = known(item, [
      "step",
      "choice",
      "authMethodId",
      "preparationActionId",
      "accessStage",
      "selection",
      "installationInput",
      "installationInputInvalid",
    ]);
    if (entry.selection !== undefined) {
      const selection = known(entry.selection, ["config", "service"]);
      if (selection.service !== null)
        known(selection.service, ["id", "model", "revision"]);
    }
    if (entry.installationInput !== undefined) {
      const installation = known(entry.installationInput, [
        "declarationId",
        "registryVersion",
        "launch",
        "values",
      ]);
      known(installation.launch, ["kind", "binary", "package", "args"]);
    }
  }
  if (raw.selections !== undefined)
    for (const item of Object.values(object(raw.selections))) {
      const selection = known(item, ["config", "service"]);
      if (selection.service !== null)
        known(selection.service, ["id", "model", "revision"]);
    }
}
export function previewEntries(
  preview: RestorePreview,
  allowed: readonly RestoreKey[],
): PreviewEntry[] {
  return allowed.map((key) => {
    const label = key === RESTORE_KEYS[0] ? S.draft : S.setup;
    const raw = preview.values[key];
    if (raw === null || raw === undefined)
      return { key, label, valid: false, summary: S.unavailable, empty: false };
    try {
      if (
        typeof raw !== "string" ||
        new TextEncoder().encode(raw).length > 32 * 1024 * 1024
      )
        throw new Error(S.unsupported);
      const value: unknown = JSON.parse(raw);
      if (key === RESTORE_KEYS[0]) {
        strictDraft(value);
        const parsed = parseDraftSnapshot(value);
        const drafts = parsed?.composers.length ?? 0;
        const queues =
          parsed?.queues.reduce(
            (sum, [, queue]) => sum + queue.blocks.length,
            0,
          ) ?? 0;
        return {
          key,
          label,
          valid: true,
          summary: S.draftCount(drafts, queues, parsed?.templateEdits ? 1 : 0),
          empty: value == null,
        };
      }
      strictSetup(value);
      const parsed = parseSetupSnapshot(value);
      return {
        key,
        label,
        valid: true,
        summary: S.setupCount(
          parsed.completed.length,
          Object.keys(parsed.progress).length,
        ),
        empty: value == null,
      };
    } catch {
      return { key, label, valid: false, summary: S.unsupported, empty: false };
    }
  });
}
export function restoreFailure(reason: unknown): {
  known: boolean;
  message: string;
  materialsPath: string | null;
  complete: boolean;
} {
  if (
    reason &&
    typeof reason === "object" &&
    "code" in reason &&
    typeof reason.code === "string" &&
    Object.hasOwn(S.errors, reason.code)
  ) {
    const value = reason as {
      code: keyof typeof S.errors;
      issue?: { kind?: StorageIssueKind };
      materialsPath?: unknown;
      materialsComplete?: unknown;
    };
    return {
      known: true,
      message:
        value.code === "storage" && value.issue?.kind
          ? storageIssueMessage(value.issue.kind)
          : S.errors[value.code],
      materialsPath:
        typeof value.materialsPath === "string" ? value.materialsPath : null,
      complete: value.materialsComplete === true,
    };
  }
  return {
    known: false,
    message: S.unknown,
    materialsPath: null,
    complete: false,
  };
}
