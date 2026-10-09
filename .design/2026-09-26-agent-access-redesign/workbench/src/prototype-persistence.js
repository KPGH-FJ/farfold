// Browser-only design state. No production data, credentials or Agent I/O.
import {
  migrateLegacyQwenAuthentication,
  removeRetiredAuthenticationSamples,
} from "./prototype-migrations.js";
import { draftTitle } from "./workbench-state.js";
import { suspendedDraft } from "./history-start-state.js";
export const PROTOTYPE_STORAGE_KEY = "farfold-workbench-review-v6";
const forbidden =
  /^(apiKey|key|token|password|secret|credential|authorization|env)$/i;
export function withoutCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !forbidden.test(key))
        .map(([key, item]) => [key, withoutCredentials(item)]),
    );
  return value;
}
export function makePrototypeSnapshot(state) {
  return { version: 6, savedAt: Date.now(), ...withoutCredentials(state) };
}
export function restorePrototypeSnapshot(snapshot) {
  if (
    snapshot?.version !== 6 ||
    !Array.isArray(snapshot.tasks) ||
    !snapshot.draft?.choice
  )
    return null;
  const state = removeRetiredAuthenticationSamples(
    migrateLegacyQwenAuthentication(structuredClone(snapshot)),
  );
  state.scene ||=
    state.tasks.length ||
    state.agents?.some((agent) => agent.added || agent.connected)
      ? "daily"
      : "first";
  state.tasks = state.tasks.map((task) => {
    const hadPendingInteraction = ["approval", "question"].includes(
      task.status,
    );
    const wasWorking =
      ["running", "submitting"].includes(task.status) ||
      hadPendingInteraction ||
      task.stopping ||
      ["waiting", "pending"].includes(task.stopPhase) ||
      task.requestState === "submitting";
    return {
      ...task,
      attachmentsNeedReview: Boolean(
        task.attachments?.length ||
        task.draftAttachments?.length ||
        task.queue?.some((item) => item.attachments?.length),
      ),
      simulatePending: false,
      ...(task.configurationChange?.phase === "pending"
        ? {
            configurationChange: {
              ...task.configurationChange,
              phase: "unknown",
            },
          }
        : {}),
      ...(task.permissionChange?.phase === "pending"
        ? { permissionChange: { ...task.permissionChange, phase: "unknown" } }
        : {}),
      ...(wasWorking
        ? {
            status: "unknown",
            unknownReason: "restart",
            // A restart is not evidence that a stop request was sent.
            stopPhase: task.stopPhase ? "unknown" : null,
            stopping: false,
            ...(hadPendingInteraction
              ? {
                  interactionExpired: true,
                  expiredInteractionKind: task.status,
                }
              : {}),
          }
        : {}),
      queuePaused: task.queue?.length ? true : task.queuePaused,
      restartNotice:
        wasWorking || task.queue?.length ? true : task.restartNotice,
    };
  });
  if (
    state.pendingSend &&
    !state.tasks.some((task) => task.id === state.pendingSend.id)
  ) {
    const attempt = state.pendingSend;
    state.tasks.unshift({
      ...attempt.draft.choice,
      ...attempt.permission,
      id: attempt.id,
      title: draftTitle(attempt.draft.text, attempt.draft.files),
      prompt: attempt.draft.text,
      sentAttachments: attempt.draft.files,
      folder: attempt.draft.folder,
      project: attempt.draft.folder || "普通对话",
      serviceSnapshot: attempt.service,
      status: "unknown",
      unknownReason: "admission",
      draft: "",
      queue: [],
      restartNotice: true,
      time: "刚才",
    });
    if (JSON.stringify(state.draft) === JSON.stringify(attempt.draft))
      state.draft = { ...state.draft, text: "", files: [] };
    state.view = "thread";
    state.active = attempt.id;
  }
  state.agents = state.agents?.map((agent) => ({
    ...agent,
    onboardingComplete:
      agent.onboardingComplete ?? agent.setupComplete === true,
    ...(agent.accessJob
      ? {
          accessJob: {
            ...agent.accessJob,
            status: "unknown",
            label: "重新打开后，仍需确认这次操作的结果",
            dueAt: null,
          },
        }
      : {}),
  }));
  state.draft = suspendedDraft(state.draft);
  if (Array.isArray(state.savedDrafts))
    state.savedDrafts = state.savedDrafts.map((item) => ({
      ...item,
      draft: suspendedDraft(item.draft),
    }));
  state.pendingSend = null;
  state.restored = true;
  state.attachmentsNeedReview = Boolean(state.draft.files?.length);
  return state;
}
export function readPrototypeState(storage) {
  try {
    return restorePrototypeSnapshot(
      JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY) || "null"),
    );
  } catch {
    return null;
  }
}
export function writePrototypeState(storage, state) {
  try {
    storage.setItem(
      PROTOTYPE_STORAGE_KEY,
      JSON.stringify(makePrototypeSnapshot(state)),
    );
    return true;
  } catch {
    return false;
  }
}

// Publish a persistent archive decision only after the write succeeded.
export function saveArchiveDecision(storage, state, result, days) {
  const next = { ...state, tasks: result.tasks, archiveDays: String(days) };
  return writePrototypeState(storage, next)
    ? { ok: true, state: next, count: result.count }
    : { ok: false, state, count: 0 };
}
