import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { storageFailureMessage } from "./storage_recovery";
import { STRINGS } from "./strings";

export const DRAFT_STORAGE_KEY = "unsentWork.v1";
const MAX_BYTES = 32 * 1024 * 1024;
export const DRAFT_STRINGS = {
  loading: "正在恢复未发送内容…",
  loadFailed: "未能读取未发送内容，请重试。原内容没有被覆盖。",
  saveFailed: "未发送内容尚未保存，请重试后再关闭。",
  tooLarge: "未发送内容过多，暂未保存。请减少附件后重试。",
  retry: "重试保存",
  attachmentFailed: "附件已无法读取，请重新选择或移除后再发送。",
  attachmentIncomplete: "图片尚未准备完成，请重新添加。",
  recovered: "已恢复未发送内容；发送前会重新检查附件。",
  uncertain: "上次发送结果尚未确认。请先查看对应对话，再决定是否重试。",
  reviewed: "已检查，继续编辑",
  openPending: "查看对应对话",
  openingPending: "正在打开对应对话…",
  abandonPending: "放弃本次重试",
  abandonPendingNote:
    "上次请求可能已经执行。放弃本次重试不会撤销已执行的操作，也不会自动重发。输入内容会保留，只有你再次发送才会开始新的请求。",
} as const;

type Status = {
  ready: boolean;
  saving: boolean;
  error: string | null;
  interactionLocked?: boolean;
};
let status: Status = { ready: false, saving: false, error: null };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let writing: Promise<void> | null = null;
const pendingAttachments = new Set<Promise<unknown>>();
let revision = 0;
let savedRevision = 0;
/** A local write failure, distinguished from Agent and load failures. */
export class DraftSaveError extends Error {
  constructor(
    message: string,
    readonly revision: number,
  ) {
    super(message);
  }
}
let snapshot: () => unknown = () => ({});
let restore: (value: unknown) => void = () => {};
let legacyInteractionLock = false;
const interactionOwners = new Set<object>();
function publish(change: Partial<Status>) {
  status = { ...status, ...change };
  listeners.forEach((fn) => fn());
}

/** One serialized settings value containing only user-owned, unsent input.
 * Loading must succeed before any write; failed/unknown versions stay intact.
 * Writes are coalesced while preserving the newest edit made during a save. */
export const draftPersistence = {
  trackAttachment(read: Promise<unknown>) {
    const task = read.finally(() => {
      pendingAttachments.delete(task);
    });
    pendingAttachments.add(task);
    void task.catch(() => undefined);
  },
  configure(read: () => unknown, hydrate: (value: unknown) => void) {
    snapshot = read;
    restore = hydrate;
  },
  snapshot: () => status,
  revision: () => revision,
  /** Only a completed write of all current input proves this revision saved. */
  isSaved(expectedRevision: number): boolean {
    return (
      Number.isSafeInteger(expectedRevision) &&
      expectedRevision >= 0 &&
      expectedRevision <= savedRevision &&
      savedRevision === revision &&
      status.ready &&
      !status.saving &&
      !status.error
    );
  },
  lockInteraction(value: boolean) {
    legacyInteractionLock = value;
    publish({ interactionLocked: value || interactionOwners.size > 0 });
  },
  /** Independent maintenance cannot release a quit/storage lock or a newer owner. */
  acquireInteractionLock(): () => void {
    const owner = {};
    interactionOwners.add(owner);
    publish({ interactionLocked: true });
    return () => {
      if (!interactionOwners.delete(owner)) return;
      publish({
        interactionLocked: legacyInteractionLock || interactionOwners.size > 0,
      });
    };
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  load(): Promise<void> {
    if (status.ready) return Promise.resolve();
    return (loading ??= invoke<unknown>("settings_get", {
      key: DRAFT_STORAGE_KEY,
    })
      .then((value) => {
        restore(value);
        publish({ ready: true, error: null });
      })
      .catch((error) => {
        const message = storageFailureMessage(error, DRAFT_STRINGS.loadFailed);
        publish({ error: message });
        throw new Error(message);
      })
      .finally(() => {
        loading = null;
      }));
  },
  changed() {
    revision++;
    if (status.ready) void this.flush().catch(() => undefined);
  },
  async flush(): Promise<void> {
    await this.load();
    while (pendingAttachments.size)
      await Promise.allSettled([...pendingAttachments]);
    if (writing) {
      await writing;
      if (savedRevision !== revision) return this.flush();
      return;
    }
    if (savedRevision === revision) return;
    writing = (async () => {
      publish({ saving: true, error: null });
      try {
        while (savedRevision !== revision) {
          const current = revision;
          // Capture now: callers can keep editing while IPC is in flight.
          const json = JSON.stringify(snapshot());
          if (new TextEncoder().encode(json).byteLength > MAX_BYTES)
            throw new Error(DRAFT_STRINGS.tooLarge);
          await invoke("settings_set", {
            key: DRAFT_STORAGE_KEY,
            value: JSON.parse(json),
          });
          savedRevision = current;
        }
      } catch (error) {
        const message =
          error instanceof Error && error.message === DRAFT_STRINGS.tooLarge
            ? error.message
            : storageFailureMessage(error, DRAFT_STRINGS.saveFailed);
        const explanation =
          message === DRAFT_STRINGS.saveFailed ||
          message === DRAFT_STRINGS.tooLarge
            ? message
            : `${message}${STRINGS.storageRecovery.unsaved}`;
        publish({ error: explanation });
        throw new DraftSaveError(explanation, revision);
      } finally {
        publish({ saving: false });
      }
    })();
    try {
      await writing;
    } finally {
      writing = null;
    }
  },
};

export function useDraftSaveStatus() {
  return useSyncExternalStore(
    draftPersistence.subscribe,
    draftPersistence.snapshot,
    draftPersistence.snapshot,
  );
}
