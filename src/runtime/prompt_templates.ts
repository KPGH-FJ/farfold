import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { draftPersistence } from "./drafts";
import {
  parsePromptTemplates,
  type PromptTemplate,
  type PromptTemplateDocument,
} from "./prompt_template_data";
import { PROMPT_TEMPLATES as S } from "./prompt_template_strings";
import { storageFailureMessage } from "./storage_recovery";
export type { PromptTemplate } from "./prompt_template_data";
export { templateEditDrafts, useTemplateEditDraft } from "./drafts";
export const PROMPT_TEMPLATES_KEY = "promptTemplates.v1";
export type PromptTemplatesSnapshot = {
  items: PromptTemplate[];
  ready: boolean;
  saving: boolean;
  error: string | null;
  uncertain: boolean;
  notice: string | null;
};
let status: PromptTemplatesSnapshot = {
  items: [],
  ready: false,
  saving: false,
  error: null,
  uncertain: false,
  notice: null,
};
let queue = Promise.resolve();
let loading: Promise<void> | null = null;
let pending: PromptTemplateDocument | null = null;
const listeners = new Set<() => void>();
function publish(change: Partial<PromptTemplatesSnapshot>) {
  status = Object.freeze({ ...status, ...change });
  listeners.forEach((fn) => fn());
}
function serial(work: () => Promise<void>): Promise<void> {
  const task = queue.then(work);
  queue = task.catch(() => undefined);
  return task;
}
function equal(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
async function read() {
  const raw = await invoke<unknown>("settings_get", {
    key: PROMPT_TEMPLATES_KEY,
  });
  return { raw, document: parsePromptTemplates(raw) };
}
function accept(
  document: PromptTemplateDocument,
  notice: string | null = status.notice,
) {
  publish({
    items: Object.freeze(document.items) as PromptTemplate[],
    ready: true,
    error: null,
    uncertain: false,
    notice,
  });
}
async function reload() {
  try {
    const { raw, document } = await read();
    if (pending && (raw === null || !equal(document, pending)))
      throw new Error(S.saveFailed);
    const confirmed = pending !== null;
    pending = null;
    accept(document, confirmed ? null : status.notice);
  } catch (error) {
    const message = storageFailureMessage(
      error,
      pending ? S.saveFailed : S.loadFailed,
    );
    publish({
      ready: pending ? status.ready : false,
      error: message,
      uncertain: pending !== null,
    });
    throw new Error(message);
  }
}
async function mutate(item: PromptTemplate | null, expected?: PromptTemplate) {
  if (pending) throw new Error(S.saveFailed);
  if (draftPersistence.snapshot().interactionLocked) throw new Error(S.changed);
  try {
    if (item)
      item = parsePromptTemplates({ version: 1, items: [item] }).items[0];
    if (expected)
      expected = parsePromptTemplates({ version: 1, items: [expected] })
        .items[0];
    if (!item && !expected) throw new Error(S.invalid);
    if (item && expected && item.id !== expected.id) throw new Error(S.invalid);
  } catch {
    publish({ error: S.invalid });
    throw new Error(S.invalid);
  }
  // The edit must survive a rejected/unknown saved-template write.
  await draftPersistence.flush();
  if (draftPersistence.snapshot().interactionLocked) throw new Error(S.changed);
  publish({ saving: true, error: null });
  try {
    let current: Awaited<ReturnType<typeof read>>;
    try {
      current = await read();
    } catch (error) {
      const message = storageFailureMessage(error, S.loadFailed);
      publish({ ready: false, error: message });
      throw new Error(message);
    }
    const previous = current.document.items.find(
      (value) => value.id === (item?.id ?? expected!.id),
    );
    accept(current.document);
    if (expected ? !equal(previous, expected) : previous !== undefined)
      throw new Error(S.changed);
    const items = item
      ? previous
        ? current.document.items.map((value) =>
            value.id === item.id ? item : value,
          )
        : [...current.document.items, item]
      : current.document.items.filter((value) => value.id !== expected!.id);
    let next: PromptTemplateDocument;
    try {
      next = parsePromptTemplates({ version: 1, items });
    } catch {
      throw new Error(S.limit);
    }
    if (equal(current.document, next)) return;
    pending = next;
    let conflict = false;
    let rejection: string | null = null;
    try {
      const result = await invoke<unknown>("prompt_templates_save", {
        expected: current.raw,
        next,
      });
      if (result && typeof result === "object" && "status" in result) {
        conflict = result.status === "conflict";
        if (
          result.status === "rejected" &&
          "message" in result &&
          typeof result.message === "string"
        )
          rejection = storageFailureMessage(result.message, S.rejected);
      }
    } catch {
      /* Rejection may follow a committed write. Only readback can settle it. */
    }
    if (conflict) {
      pending = null;
      await reload();
      throw new Error(S.changed);
    }
    if (rejection) {
      // This receipt is emitted only before any write or after verified
      // rollback. It cannot later commit. Still re-read before another edit.
      pending = null;
      await reload();
      if (equal({ version: 1, items: status.items }, next)) {
        publish({ notice: null });
        return;
      }
      publish({ error: rejection });
      throw new Error(rejection);
    }
    await reload();
  } catch (error) {
    const messages: readonly string[] = [
      S.invalid,
      S.limit,
      S.changed,
      S.loadFailed,
      S.saveFailed,
      S.rejected,
    ];
    const known =
      error instanceof Error &&
      (messages.includes(error.message) || error.message === status.error);
    const message = known
      ? (error as Error).message
      : storageFailureMessage(error, S.saveFailed);
    publish({ error: message, uncertain: pending !== null });
    throw new Error(message);
  } finally {
    publish({ saving: false });
  }
}
export const promptTemplates = {
  snapshot: () => status,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  load(): Promise<void> {
    if (status.ready) return Promise.resolve();
    return (loading ??= serial(reload).finally(() => {
      loading = null;
    }));
  },
  reload: () => serial(reload),
  recoverUnknown(): Promise<void> {
    const unresolved = pending;
    return serial(async () => {
      if (!unresolved || pending !== unresolved) throw new Error(S.changed);
      try {
        const { raw, document } = await read();
        const confirmed = raw !== null && equal(document, unresolved);
        pending = null;
        // Explicitly releasing the retry guard makes no claim about the old
        // write. Every subsequent write still compares the entire baseline.
        accept(document, confirmed ? null : S.unknownNote);
      } catch (error) {
        const message = storageFailureMessage(error, S.loadFailed);
        publish({ error: message, uncertain: true });
        throw new Error(message);
      }
    });
  },
  save(item: PromptTemplate, expected?: PromptTemplate) {
    const submitted = structuredClone(item);
    const before =
      expected === undefined ? undefined : structuredClone(expected);
    return serial(() => mutate(submitted, before));
  },
  remove(expected: PromptTemplate) {
    const before = structuredClone(expected);
    return serial(() => mutate(null, before));
  },
};

export function usePromptTemplates() {
  const snapshot = useSyncExternalStore(
    promptTemplates.subscribe,
    promptTemplates.snapshot,
    promptTemplates.snapshot,
  );
  useEffect(() => {
    void promptTemplates.load().catch(() => undefined);
  }, []);
  return snapshot;
}
