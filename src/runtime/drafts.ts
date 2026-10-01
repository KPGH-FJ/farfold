import { useSyncExternalStore } from "react";
import type { ServiceSelection } from "./credentials";
import type { PromptBlock } from "./session_types";
import { draftPersistence } from "./draft_storage";
import { archiveActivity } from "./archive_activity";
export { draftPersistence } from "./draft_storage";

export interface DraftAttachment {
  id: string;
  kind: "file" | "image";
  name: string;
  uri?: string;
  data?: string;
  mimeType?: string;
  content?: string;
  loading?: boolean;
  recovered?: boolean;
}

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  sendPending?: boolean;
  queueEdit?: { index: number; original: PromptBlock[] };
  pendingConversation?: PendingConversation;
}

/** Target of an unconfirmed first message; never a copy of Agent history. */
export interface PendingConversation {
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  service?: ServiceSelection;
  serviceRevision?: string;
}

const empty: ComposerDraft = { text: "", attachments: [] };
const values = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
const generations = new Map<string, number>();

function conversationKey(key: string): string | undefined {
  if (key.startsWith("session:")) return key.slice("session:".length);
  if (key.startsWith("queue-edit:")) return key.slice("queue-edit:".length);
  return undefined;
}
function changed(threadKey?: string) {
  if (threadKey) archiveActivity.stageDraftEdit(threadKey);
  listeners.forEach((fn) => fn());
  draftPersistence.changed();
  if (threadKey && draftPersistence.snapshot().ready)
    void archiveActivity.flush().catch(() => undefined);
}

/** Only unsent input. No Agent transcript, events, auth forms or secrets. */
export const composerDrafts = {
  read(key: string): ComposerDraft {
    return values.get(key) ?? empty;
  },
  update(key: string, update: (draft: ComposerDraft) => ComposerDraft) {
    const next = update(this.read(key));
    if (
      !next.text &&
      next.attachments.length === 0 &&
      !next.queueEdit &&
      !next.pendingConversation
    )
      values.delete(key);
    else values.set(key, next);
    changed(conversationKey(key));
  },
  generation(key: string) {
    return generations.get(key) ?? 0;
  },
  clear(key: string) {
    generations.set(key, this.generation(key) + 1);
    const existed = values.has(key);
    values.delete(key);
    changed(existed ? conversationKey(key) : undefined);
  },
  /** A delayed admission must not erase input typed after the send started. */
  clearIfUnchanged(key: string, sent: ComposerDraft) {
    if (this.read(key) === sent) this.clear(key);
  },
  hasContent(key: string) {
    const value = this.read(key);
    return Boolean(value.text.trim() || value.attachments.length);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useComposerDraft(key: string): ComposerDraft {
  return useSyncExternalStore(
    composerDrafts.subscribe,
    () => composerDrafts.read(key),
    () => composerDrafts.read(key),
  );
}

type ConversationChoice = {
  agentId: string | null;
  cwd: string | null;
  service: (ServiceSelection & { revision: string }) | null;
  config: Record<string, unknown>;
};
const choice: ConversationChoice = {
  agentId: null,
  cwd: null,
  service: null,
  config: {},
};
export const newConversationChoice = new Proxy(choice, {
  set(target, property, value) {
    if (property === "config" && value && typeof value === "object")
      value = Object.fromEntries(
        Object.entries(value).filter(
          ([, v]) =>
            typeof v === "string" ||
            typeof v === "boolean" ||
            (typeof v === "number" && Number.isFinite(v)),
        ),
      );
    if (JSON.stringify(Reflect.get(target, property)) === JSON.stringify(value))
      return true;
    Reflect.set(target, property, value);
    changed();
    return true;
  },
});

export interface FileFeedback {
  text: string;
  selection: {
    side: "before" | "after";
    line: number;
    endLine?: number;
  } | null;
  lineInput?: { side: "before" | "after"; text: string };
  contentId?: string;
  scope?: "file" | "fragment";
}
export interface SavedFileFeedback extends FileFeedback {
  path: string;
}
const emptyFeedback: FileFeedback = { text: "", selection: null };
const emptyFeedbackEntries: Readonly<Record<string, SavedFileFeedback>> = {};
const feedbackValues = new Map<string, Record<string, SavedFileFeedback>>();
const feedbackKey = (path: string, contentId?: string) =>
  JSON.stringify([path, contentId ?? null]);
export const fileFeedbackDrafts = {
  entries(threadKey: string): Readonly<Record<string, SavedFileFeedback>> {
    return feedbackValues.get(threadKey) ?? emptyFeedbackEntries;
  },
  read(threadKey: string, path: string, contentId?: string): FileFeedback {
    const entries = this.entries(threadKey);
    if (contentId !== undefined)
      return entries[feedbackKey(path, contentId)] ?? emptyFeedback;
    // Compatibility for callers with no version: never use this to attach an
    // old location to newly displayed content.
    return (
      Object.values(entries)
        .filter((entry) => entry.path === path)
        .at(-1) ?? emptyFeedback
    );
  },
  update(threadKey: string, path: string, value: FileFeedback) {
    const current = { ...feedbackValues.get(threadKey) };
    const key = feedbackKey(path, value.contentId);
    if (value.text || value.selection || value.lineInput?.text)
      current[key] = { ...value, path };
    else delete current[key];
    if (Object.keys(current).length) feedbackValues.set(threadKey, current);
    else feedbackValues.delete(threadKey);
    changed(threadKey);
  },
  clear(threadKey: string, path: string, contentId?: string) {
    const current = { ...this.entries(threadKey) };
    for (const [key, entry] of Object.entries(current))
      if (
        entry.path === path &&
        (contentId === undefined || entry.contentId === contentId)
      )
        delete current[key];
    if (Object.keys(current).length) feedbackValues.set(threadKey, current);
    else feedbackValues.delete(threadKey);
    changed(threadKey);
  },
  /** Move one exact draft into the composer in one persistence snapshot. */
  take(threadKey: string, key: string, text: string): boolean {
    if (!this.entries(threadKey)[key] || !text.trim()) return false;
    const draftKey = `session:${threadKey}`;
    const draft = composerDrafts.read(draftKey);
    values.set(draftKey, {
      ...draft,
      text: draft.text ? `${draft.text}\n\n${text}` : text,
    });
    const current = { ...this.entries(threadKey) };
    delete current[key];
    if (Object.keys(current).length) feedbackValues.set(threadKey, current);
    else feedbackValues.delete(threadKey);
    changed(threadKey);
    return true;
  },
};
export function fileFeedbackKey(path: string, contentId?: string) {
  return feedbackKey(path, contentId);
}
export function useFileFeedbackEntries(threadKey: string) {
  return useSyncExternalStore(
    composerDrafts.subscribe,
    () => fileFeedbackDrafts.entries(threadKey),
    () => fileFeedbackDrafts.entries(threadKey),
  );
}
export function useFileFeedback(
  threadKey: string,
  path: string,
  contentId?: string,
) {
  return useSyncExternalStore(
    composerDrafts.subscribe,
    () => fileFeedbackDrafts.read(threadKey, path, contentId),
    () => fileFeedbackDrafts.read(threadKey, path, contentId),
  );
}

interface QueuedDraft {
  blocks: PromptBlock[][];
  uncertainIndex: number | null;
}
const queueValues = new Map<string, QueuedDraft>();
export const draftQueues = {
  read(key: string): QueuedDraft | null {
    const value = queueValues.get(key);
    return value ? structuredClone(value) : null;
  },
  write(key: string, blocks: PromptBlock[][], uncertainIndex: number | null) {
    const next = blocks.length ? { blocks, uncertainIndex } : undefined;
    if (JSON.stringify(queueValues.get(key)) === JSON.stringify(next)) return;
    if (next) queueValues.set(key, structuredClone(next));
    else queueValues.delete(key);
    changed(key);
  },
};

export function hasUnsentWork(threadKey: string) {
  return (
    composerDrafts.hasContent(`session:${threadKey}`) ||
    Boolean(composerDrafts.read(`queue-edit:${threadKey}`).queueEdit) ||
    Object.values(feedbackValues.get(threadKey) ?? {}).some((v) =>
      v.text.trim(),
    ) ||
    Boolean(queueValues.get(threadKey)?.blocks.length)
  );
}

/** Existing conversation identities only; no parallel index or content copy. */
export function unsentConversationKeys(): string[] {
  const keys = new Set([...feedbackValues.keys(), ...queueValues.keys()]);
  for (const key of values.keys()) {
    if (key.startsWith("session:")) keys.add(key.slice("session:".length));
    if (key.startsWith("queue-edit:"))
      keys.add(key.slice("queue-edit:".length));
  }
  return [...keys].filter((key) => hasUnsentWork(key));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid draft");
  return value as Record<string, unknown>;
}
function isPromptBlocks(value: unknown): value is PromptBlock[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== "object") return false;
      if (item.type === "text") return typeof item.text === "string";
      if (item.type === "image")
        return (
          typeof item.data === "string" && typeof item.mimeType === "string"
        );
      if (item.type === "resource_link")
        return typeof item.uri === "string" && typeof item.name === "string";
      if (item.type === "resource")
        return (
          item.resource &&
          typeof item.resource.uri === "string" &&
          typeof item.resource.text === "string" &&
          typeof item.resource.mimeType === "string"
        );
      return false;
    })
  );
}
function parseComposer(value: unknown): ComposerDraft {
  const raw = record(value);
  if (typeof raw.text !== "string" || !Array.isArray(raw.attachments))
    throw new Error("invalid draft");
  const editing =
    raw.queueEdit === undefined ? undefined : record(raw.queueEdit);
  if (
    editing &&
    (!Number.isSafeInteger(editing.index) ||
      Number(editing.index) < 0 ||
      !isPromptBlocks(editing.original))
  )
    throw new Error("invalid queue editor");
  const pending =
    raw.pendingConversation === undefined
      ? undefined
      : record(raw.pendingConversation);
  if (pending) {
    if (
      ![pending.agentId, pending.cwd, pending.nativeSessionId].every(
        (v) => typeof v === "string" && v.length > 0,
      )
    )
      throw new Error("invalid pending target");
    if (pending.service !== undefined) {
      const service = record(pending.service);
      if (
        ![service.id, service.model].every(
          (v) => typeof v === "string" && v.length > 0,
        )
      )
        throw new Error("invalid pending source");
    }
    if (
      pending.serviceRevision !== undefined &&
      typeof pending.serviceRevision !== "string"
    )
      throw new Error("invalid pending revision");
  }
  return {
    text: raw.text,
    pendingConversation: pending as unknown as PendingConversation | undefined,
    queueEdit: editing as ComposerDraft["queueEdit"],
    sendPending: raw.sendPending === true,
    attachments: raw.attachments.map((item: unknown) => {
      const a = record(item);
      if (
        typeof a.id !== "string" ||
        typeof a.name !== "string" ||
        !["file", "image"].includes(String(a.kind))
      )
        throw new Error("invalid attachment");
      return {
        id: a.id,
        name: a.name,
        kind: a.kind as "file" | "image",
        uri: typeof a.uri === "string" ? a.uri : undefined,
        data: typeof a.data === "string" ? a.data : undefined,
        mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
        recovered: true,
      };
    }),
  };
}
function serializeComposer(value: ComposerDraft): ComposerDraft {
  return {
    text: value.text,
    pendingConversation: value.pendingConversation,
    queueEdit: value.queueEdit,
    sendPending: value.sendPending,
    attachments: value.attachments.map(
      ({
        content: _content,
        loading: _loading,
        recovered: _recovered,
        ...attachment
      }) => attachment,
    ),
  };
}

draftPersistence.configure(
  () => ({
    version: 1,
    composers: Object.fromEntries(
      [...values]
        .filter(
          ([key]) =>
            key === "new" ||
            key.startsWith("session:") ||
            key.startsWith("queue-edit:"),
        )
        .map(([key, value]) => [key, serializeComposer(value)]),
    ),
    choice,
    feedback: Object.fromEntries(feedbackValues),
    queues: Object.fromEntries(queueValues),
    activity: archiveActivity.snapshot(),
  }),
  (value) => {
    if (value === null || value === undefined) return;
    const raw = record(value);
    if (
      raw.version !== 1 ||
      Object.keys(raw).some(
        (key) =>
          ![
            "version",
            "composers",
            "choice",
            "feedback",
            "queues",
            "activity",
          ].includes(key),
      )
    )
      throw new Error("unsupported draft format");
    // Validate the entire value before publishing any restored content.
    const composers = Object.entries(record(raw.composers)).map(
      ([key, item]) => [key, parseComposer(item)] as const,
    );
    const selected = record(raw.choice);
    if (
      (selected.agentId !== null && typeof selected.agentId !== "string") ||
      (selected.cwd !== null && typeof selected.cwd !== "string")
    )
      throw new Error("invalid choice");
    const config = record(selected.config);
    if (
      Object.values(config).some(
        (v) => !["string", "number", "boolean"].includes(typeof v),
      )
    )
      throw new Error("invalid option");
    if (selected.service !== null) {
      const service = record(selected.service);
      if (
        ![service.id, service.model, service.revision].every(
          (v) => typeof v === "string",
        )
      )
        throw new Error("invalid source");
    }
    const feedback = Object.entries(record(raw.feedback)).map(
      ([key, items]) => {
        const entries = Object.entries(record(items)).map(
          ([storedKey, item]) => {
            const itemValue = record(item);
            // v1 path-keyed drafts migrate without rewriting any history. New
            // entries retain a flat text field for the existing archive guard.
            const path =
              typeof itemValue.path === "string" ? itemValue.path : storedKey;
            const contentId =
              typeof itemValue.contentId === "string"
                ? itemValue.contentId
                : undefined;
            if (typeof itemValue.text !== "string")
              throw new Error("invalid feedback");
            const selection =
              itemValue.selection === null ? null : record(itemValue.selection);
            if (
              selection &&
              (!["before", "after"].includes(String(selection.side)) ||
                !Number.isSafeInteger(selection.line) ||
                Number(selection.line) < 1 ||
                (selection.endLine !== undefined &&
                  (!Number.isSafeInteger(selection.endLine) ||
                    Number(selection.endLine) < Number(selection.line))))
            )
              throw new Error("invalid line");
            const lineInput = itemValue.lineInput
              ? record(itemValue.lineInput)
              : undefined;
            if (
              lineInput &&
              (!["before", "after"].includes(String(lineInput.side)) ||
                typeof lineInput.text !== "string")
            )
              throw new Error("invalid line input");
            return [
              feedbackKey(path, contentId),
              {
                path,
                text: itemValue.text,
                selection,
                ...(lineInput ? { lineInput } : {}),
                contentId,
                scope:
                  itemValue.scope === "file" || itemValue.scope === "fragment"
                    ? itemValue.scope
                    : undefined,
              },
            ] as const;
          },
        );
        return [
          key,
          Object.fromEntries(entries) as Record<string, SavedFileFeedback>,
        ] as const;
      },
    );
    const queues = Object.entries(record(raw.queues)).map(([key, item]) => {
      const q = record(item);
      if (
        !Array.isArray(q.blocks) ||
        q.blocks.some((blocks) => !isPromptBlocks(blocks))
      )
        throw new Error("invalid queue");
      if (
        q.uncertainIndex !== null &&
        (!Number.isInteger(q.uncertainIndex) ||
          Number(q.uncertainIndex) < 0 ||
          Number(q.uncertainIndex) >= q.blocks.length)
      )
        throw new Error("invalid pending message");
      return [key, q as unknown as QueuedDraft] as const;
    });
    archiveActivity.restore(raw.activity);
    for (const [key, draft] of composers)
      if (!values.has(key)) values.set(key, draft);
    Object.assign(choice, selected);
    for (const [key, data] of feedback)
      if (!feedbackValues.has(key)) feedbackValues.set(key, data);
    for (const [key, data] of queues)
      if (!queueValues.has(key)) queueValues.set(key, data);
    listeners.forEach((fn) => fn());
  },
);

/** Add reviewed feedback to this conversation without dispatching a prompt. */
export function appendConversationFeedback(
  threadKey: string,
  text: string,
): void {
  const addition = text.trim();
  if (!addition) return;
  composerDrafts.update(`session:${threadKey}`, (draft) => ({
    ...draft,
    text: draft.text ? `${draft.text}\n\n${addition}` : addition,
  }));
}
