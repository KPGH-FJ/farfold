import { localResourcePath } from "./file_delivery";
import { encodeDraftAudio, decodeDraftAudio } from "./draft_audio_encoding";
import { parseLocalAudio, type LocalAudio } from "./audio_input";
import { useSyncExternalStore } from "react";
import type { ServiceSelection } from "./credentials";
import type { PromptBlock } from "./session_types";
import {
  parseApprovedDocumentText,
  type ApprovedDocumentText,
} from "./document_input_types";
import { draftPersistence } from "./draft_storage";
import { REDESIGN } from "./redesign_strings";
import { archiveActivity, parseArchiveActivity } from "./archive_activity";
import {
  templateEditDrafts,
  restoreTemplateEdit,
} from "./template_edit_drafts";
import { parseTemplateEdit } from "./prompt_template_data";
import {
  parseFeedbackAnchor,
  type FileFeedbackAnchor,
} from "./file_feedback_anchor";
export {
  templateEditDrafts,
  useTemplateEditDraft,
} from "./template_edit_drafts";
export { draftPersistence } from "./draft_storage";

export interface DraftAttachment {
  id: string;
  kind: "file" | "image" | "audio";
  localAudio?: LocalAudio | null;
  audioClassificationFailed?: boolean;
  name: string;
  uri?: string;
  data?: string;
  mimeType?: string;
  content?: string;
  /** Explicit unsent file delivery intent. Absence retains legacy behavior;
   * cached body presence and current Agent capabilities never infer intent. */
  deliveryMode?: "location" | "text";
  /** Explicitly chosen document text, retained only while input is unsent. */
  documentText?: ApprovedDocumentText;
  loading?: boolean;
  recovered?: boolean;
  /** Transient preview eligibility for these exact checked bytes and source.
   * It is never persisted and never authorizes sending. */
  imageChecked?: { data: string; mimeType: string; uri?: string };
}

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  sendPending?: boolean;
  queueEdit?: { index: number; original: PromptBlock[] };
  pendingConversation?: PendingConversation;
  /** A user-owned unsent draft retained before starting a different conversation. */
  savedChoice?: ConversationChoice;
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
const queueHandoffDrafts = new WeakMap<ComposerDraft, string>();
const listeners = new Set<() => void>();
const generations = new Map<string, number>();
let draftRevision = 0;

function conversationKey(key: string): string | undefined {
  if (key.startsWith("session:")) return key.slice("session:".length);
  if (key.startsWith("queue-edit:")) return key.slice("queue-edit:".length);
  if (key.startsWith("resend:")) return key.slice("resend:".length);
  return undefined;
}
function publishDrafts() {
  draftRevision++;
  listeners.forEach((fn) => fn());
}
function changed(threadKey?: string) {
  if (restoredHandoff && !ownsRestoredHandoff(restoredHandoff))
    releaseRestoredHandoff(restoredHandoff);
  if (threadKey) archiveActivity.stageDraftEdit(threadKey);
  publishDrafts();
  draftPersistence.changed();
  if (threadKey && draftPersistence.snapshot().ready)
    void archiveActivity.flush().catch(() => undefined);
}

type PreservedNew = {
  draft: ComposerDraft;
  generation: number;
  selection: string;
  interrupted: () => boolean;
};
const retainedNewKeys = new WeakMap<ComposerDraft, Map<string, string>>();
const savingRestoredDrafts = new WeakSet<ComposerDraft>();
type RestoredHandoff = {
  key: string;
  source: ComposerDraft;
  active: ComposerDraft;
  generation: number;
  selection: string;
  unsubscribe: () => void;
};
let restoredHandoff: RestoredHandoff | undefined;

function sameRestoredDraft(handoff: RestoredHandoff): boolean {
  return (
    values.get("new") === handoff.active &&
    composerDrafts.generation("new") === handoff.generation &&
    JSON.stringify(choice) === handoff.selection
  );
}

function ownsRestoredHandoff(handoff: RestoredHandoff): boolean {
  return (
    restoredHandoff === handoff &&
    values.get(handoff.key) === handoff.source &&
    sameRestoredDraft(handoff)
  );
}

function releaseRestoredHandoff(handoff: RestoredHandoff): void {
  restoredHandoff = undefined;
  handoff.unsubscribe();
}

function finishRestoredHandoff(handoff: RestoredHandoff): void {
  if (!ownsRestoredHandoff(handoff)) return;
  releaseRestoredHandoff(handoff);
  values.delete(handoff.key);
  // The acknowledged snapshot already omitted this source.
  publishDrafts();
}

function isRestoredSource(key: string, draft: ComposerDraft): boolean {
  return (
    restoredHandoff?.key === key &&
    restoredHandoff.source === draft &&
    ownsRestoredHandoff(restoredHandoff)
  );
}

function capturePreservedNew(): PreservedNew {
  return {
    draft: composerDrafts.read("new"),
    generation: composerDrafts.generation("new"),
    selection: JSON.stringify(choice),
    interrupted: draftPersistence.captureInteractionInterruption(),
  };
}
function assertPreservedNew(ticket: PreservedNew) {
  if (
    ticket.interrupted() ||
    composerDrafts.read("new") !== ticket.draft ||
    composerDrafts.generation("new") !== ticket.generation ||
    JSON.stringify(choice) !== ticket.selection
  )
    throw new Error(REDESIGN.draftChanged);
  if (
    ticket.draft.sendPending ||
    ticket.draft.pendingConversation ||
    ticket.draft.attachments.some((a) => a.loading)
  )
    throw new Error(REDESIGN.pendingDraft);
}

function stagePreservedNew(ticket: PreservedNew): boolean {
  if (!composerDrafts.hasContent("new")) return false;
  let retained = retainedNewKeys.get(ticket.draft);
  if (!retained) {
    retained = new Map();
    retainedNewKeys.set(ticket.draft, retained);
  }
  const identity = `${ticket.generation}:${ticket.selection}`;
  const retainedKey = retained.get(identity);
  // A failed write keeps the staged copy for a retry of this exact input.
  if (retainedKey && values.has(retainedKey)) return false;
  const key = `saved-new:${crypto.randomUUID()}`;
  values.set(key, {
    ...structuredClone(ticket.draft),
    savedChoice: structuredClone(choice),
  });
  retained.set(identity, key);
  return true;
}

/** Only unsent input. No Agent transcript, events, auth forms or secrets. */
export const composerDrafts = {
  revision: () => draftRevision,
  preserved() {
    return [...values].filter(
      ([key, draft]) => key.startsWith("saved-new:") && !!draft.savedChoice,
    );
  },
  /** A displayed row may outlive its source or its pending restore. */
  canRestorePreserved(key: string, listed: ComposerDraft): boolean {
    return values.get(key) === listed && !savingRestoredDrafts.has(listed);
  },
  /** Persist the original before the caller replaces the active input. */
  async preserveNew(ticket = capturePreservedNew()) {
    await draftPersistence.flush();
    assertPreservedNew(ticket);
    if (!this.hasContent("new")) return ticket;
    if (stagePreservedNew(ticket)) changed();
    await draftPersistence.flush();
    assertPreservedNew(ticket);
    return ticket;
  },
  clearPreservedNew(ticket: PreservedNew) {
    assertPreservedNew(ticket);
    this.clear("new");
  },
  async restorePreserved(key: string) {
    const saved = values.get(key);
    if (
      !key.startsWith("saved-new:") ||
      !saved?.savedChoice ||
      savingRestoredDrafts.has(saved)
    )
      return false;
    const pending = restoredHandoff;
    if (
      pending?.key === key &&
      pending.source === saved &&
      ownsRestoredHandoff(pending)
    ) {
      savingRestoredDrafts.add(saved);
      try {
        await draftPersistence.flush();
        if (!sameRestoredDraft(pending)) throw new Error(REDESIGN.draftChanged);
        finishRestoredHandoff(pending);
        return true;
      } finally {
        savingRestoredDrafts.delete(saved);
      }
    }
    // The restore belongs to the draft visible when the user requested it,
    // including while an earlier save still owns the storage writer.
    const ticket = capturePreservedNew();
    await draftPersistence.flush();
    assertPreservedNew(ticket);
    if (values.get(key) !== saved) return false;
    const { savedChoice, ...content } = structuredClone(saved);
    savingRestoredDrafts.add(saved);
    const active = {
      ...content,
      attachments: content.attachments.map((a) => ({
        ...a,
        recovered: true,
        imageChecked: undefined,
      })),
    };
    // Both original drafts are durable. Swap their roles in one snapshot so
    // neither full attachment set has to fit twice during the move.
    stagePreservedNew(ticket);
    values.set("new", active);
    Object.assign(choice, savedChoice, {
      reviewRequired:
        savedChoice?.reviewRequired === true ||
        Boolean(savedChoice?.service && !savedChoice.service.revision),
    });
    const generation = this.generation("new") + 1;
    generations.set("new", generation);
    if (restoredHandoff) releaseRestoredHandoff(restoredHandoff);
    const revision = draftPersistence.revision() + 1;
    const handoff: RestoredHandoff = {
      key,
      source: saved,
      active,
      generation,
      selection: JSON.stringify(choice),
      unsubscribe: draftPersistence.subscribe(() => {
        if (draftPersistence.isSaved(revision)) finishRestoredHandoff(handoff);
      }),
    };
    restoredHandoff = handoff;
    changed();
    // Publish the restored choice to the UI immediately. A failed save keeps
    // both retained copies and the global save-error guard; it must not leave
    // restored text displayed under the previous Agent selection.
    void draftPersistence
      .flush()
      .then(() => finishRestoredHandoff(handoff))
      .catch(() => undefined)
      .finally(() => {
        savingRestoredDrafts.delete(saved);
      });
    return true;
  },
  read(key: string): ComposerDraft {
    return values.get(key) ?? empty;
  },
  /** Keep the editor visible while the same snapshot gives the queue ownership. */
  holdForQueue(key: string, draft: ComposerDraft): () => void {
    queueHandoffDrafts.set(draft, key);
    return () => queueHandoffDrafts.delete(draft);
  },
  update(key: string, update: (draft: ComposerDraft) => ComposerDraft) {
    let next = update(this.read(key));
    const attachments = next.attachments.map((attachment) => {
      const checked = attachment.imageChecked;
      if (
        checked &&
        (attachment.kind !== "image" ||
          checked.data !== attachment.data ||
          checked.mimeType !== attachment.mimeType ||
          checked.uri !== attachment.uri)
      ) {
        const { imageChecked: _checked, ...remaining } = attachment;
        return remaining;
      }
      return attachment;
    });
    if (
      attachments.some(
        (attachment, index) => attachment !== next.attachments[index],
      )
    )
      next = { ...next, attachments };
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

export type ConversationChoice = {
  agentId: string | null;
  cwd: string | null;
  reviewRequired?: boolean;
  service: (ServiceSelection & { revision: string }) | null;
  config: Record<string, unknown>;
};
const choice: ConversationChoice = {
  agentId: null,
  cwd: null,
  reviewRequired: false,
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
  anchor?: FileFeedbackAnchor;
}

/** An explicit currently visible input; never persisted with an opinion. */
export interface FileFeedbackDestination {
  readonly threadKey: string;
  readonly draftKey: string;
  readonly isCurrent: () => boolean;
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
    if (value.text || value.selection || value.lineInput?.text || value.anchor)
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
  take(
    threadKey: string,
    key: string,
    text: string,
    destination?: FileFeedbackDestination,
  ): boolean {
    if (!this.entries(threadKey)[key] || !text.trim()) return false;
    const draftKey = destination?.draftKey ?? `session:${threadKey}`;
    if (
      destination &&
      (destination.threadKey !== threadKey ||
        (draftKey !== "new" && draftKey !== `session:${threadKey}`) ||
        !destination.isCurrent())
    )
      return false;
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
  /** Historical outcome notice only; never an active request or retry. */
  outcomeUnknown?: boolean;
}
const queueValues = new Map<string, QueuedDraft>();
export const draftQueues = {
  read(key: string): QueuedDraft | null {
    const value = queueValues.get(key);
    return value ? structuredClone(value) : null;
  },
  write(
    key: string,
    blocks: PromptBlock[][],
    uncertainIndex: number | null,
    outcomeUnknown = false,
  ) {
    const next =
      blocks.length || outcomeUnknown
        ? {
            blocks,
            uncertainIndex,
            ...(outcomeUnknown ? { outcomeUnknown } : {}),
          }
        : undefined;
    if (JSON.stringify(queueValues.get(key)) === JSON.stringify(next)) return;
    if (next) queueValues.set(key, structuredClone(next));
    else queueValues.delete(key);
    changed(key);
  },
};

export function hasUnsentWork(threadKey: string) {
  return (
    composerDrafts.hasContent(`session:${threadKey}`) ||
    composerDrafts.hasContent(`resend:${threadKey}`) ||
    Boolean(composerDrafts.read(`resend:${threadKey}`).sendPending) ||
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
    if (key.startsWith("resend:")) keys.add(key.slice("resend:".length));
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
      if (item.type !== "resource" && item.localDocumentText !== undefined)
        return false;
      if (item.type === "text") return typeof item.text === "string";
      if (item.type === "audio")
        return (
          typeof item.data === "string" && typeof item.mimeType === "string"
        );
      if (item.type === "image")
        return (
          typeof item.data === "string" && typeof item.mimeType === "string"
        );
      if (item.type === "resource_link")
        return typeof item.uri === "string" && typeof item.name === "string";
      if (item.type === "resource") {
        const valid = Boolean(
          item.resource &&
          typeof item.resource.uri === "string" &&
          typeof item.resource.text === "string" &&
          typeof item.resource.mimeType === "string",
        );
        if (!valid) return false;
        if (item.localDocumentText !== undefined) {
          try {
            parseApprovedDocumentText({
              text: item.resource.text,
              local: item.localDocumentText,
            });
          } catch {
            return false;
          }
        }
        return true;
      }
      return false;
    })
  );
}
function parseChoice(value: unknown): ConversationChoice {
  const selected = record(value);
  if (
    (selected.agentId !== null && typeof selected.agentId !== "string") ||
    (selected.cwd !== null && typeof selected.cwd !== "string")
  )
    throw new Error("invalid choice");
  const config = record(selected.config);
  if (
    Object.values(config).some(
      (v) =>
        !["string", "number", "boolean"].includes(typeof v) ||
        (typeof v === "number" && !Number.isFinite(v)),
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
  if (
    selected.reviewRequired !== undefined &&
    typeof selected.reviewRequired !== "boolean"
  )
    throw new Error("invalid review state");
  return {
    ...selected,
    reviewRequired: selected.reviewRequired === true,
  } as ConversationChoice;
}
function retainedAudioSource(value: unknown): LocalAudio | null {
  // Unknown saved fields must block replacement of the complete snapshot.
  // Known malformed legacy sources still lose read authority below.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if (
      Object.keys(source).some(
        (key) =>
          ![
            "file",
            "channels",
            "sampleRate",
            "bitsPerSample",
            "frames",
            "durationMs",
          ].includes(key),
      )
    )
      throw new Error("unsupported draft audio source");
    const file = source.file;
    if (
      file &&
      typeof file === "object" &&
      !Array.isArray(file) &&
      Object.keys(file).some(
        (key) =>
          ![
            "root",
            "path",
            "resolvedPath",
            "name",
            "size",
            "sha256",
            "version",
          ].includes(key),
      )
    )
      throw new Error("unsupported draft audio source");
  }
  try {
    return parseLocalAudio(value);
  } catch {
    return null;
  }
}
function parseComposer(value: unknown): ComposerDraft {
  const raw = record(value);
  // Reconstructing only supported fields must not silently discard newer
  // persisted input before an ordinary edit replaces the saved snapshot.
  if (
    Object.keys(raw).some(
      (key) =>
        ![
          "text",
          "attachments",
          "sendPending",
          "queueEdit",
          "pendingConversation",
          "savedChoice",
        ].includes(key),
    ) ||
    typeof raw.text !== "string" ||
    !Array.isArray(raw.attachments) ||
    (raw.sendPending !== undefined && typeof raw.sendPending !== "boolean")
  )
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
    ...(raw.savedChoice === undefined
      ? {}
      : { savedChoice: parseChoice(raw.savedChoice) }),
    pendingConversation: pending as unknown as PendingConversation | undefined,
    queueEdit: editing as ComposerDraft["queueEdit"],
    sendPending: raw.sendPending === true,
    attachments: raw.attachments.map((item: unknown) => {
      const a = record(item);
      if (
        Object.keys(a).some(
          (key) =>
            ![
              "id",
              "name",
              "kind",
              "uri",
              "data",
              "mimeType",
              "deliveryMode",
              "documentText",
              "localAudio",
              "audioClassificationFailed",
              // Known legacy transient fields remain readable but are not trusted.
              "content",
              "loading",
              "recovered",
              "imageChecked",
            ].includes(key),
        ) ||
        typeof a.id !== "string" ||
        typeof a.name !== "string" ||
        typeof a.kind !== "string" ||
        !["file", "image", "audio"].includes(a.kind) ||
        ["uri", "data", "mimeType"].some(
          (key) => a[key] !== undefined && typeof a[key] !== "string",
        )
      )
        throw new Error("invalid attachment");
      if (
        a.deliveryMode !== undefined &&
        (a.kind !== "file" ||
          (a.deliveryMode !== "location" && a.deliveryMode !== "text"))
      )
        throw new Error("invalid attachment delivery");
      const documentText =
        a.documentText === undefined
          ? undefined
          : parseApprovedDocumentText(a.documentText);
      if (documentText && (a.kind !== "file" || typeof a.uri !== "string"))
        throw new Error("invalid document attachment");
      let audioSource =
        a.kind === "audio" ? retainedAudioSource(a.localAudio) : null;
      const uri = typeof a.uri === "string" ? a.uri : undefined;
      if (
        a.kind === "audio" &&
        (!uri || localResourcePath(uri) !== audioSource?.file.path)
      )
        audioSource = null;
      return {
        id: a.id,
        name: a.name,
        kind: a.kind as DraftAttachment["kind"],
        ...(a.kind === "audio" ? { localAudio: audioSource } : {}),
        ...(a.audioClassificationFailed === true
          ? { audioClassificationFailed: true }
          : {}),
        uri: a.kind === "audio" && !audioSource ? undefined : uri,
        data: typeof a.data === "string" ? a.data : undefined,
        mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
        ...(a.deliveryMode !== undefined
          ? { deliveryMode: a.deliveryMode as DraftAttachment["deliveryMode"] }
          : {}),
        ...(documentText ? { documentText } : {}),
        recovered: true,
      };
    }),
  };
}
function serializeComposer(value: ComposerDraft): ComposerDraft {
  return {
    text: value.text,
    ...(value.savedChoice ? { savedChoice: value.savedChoice } : {}),
    pendingConversation: value.pendingConversation,
    queueEdit: value.queueEdit,
    sendPending: value.sendPending,
    attachments: value.attachments.map(
      ({
        content: _content,
        loading: _loading,
        recovered: _recovered,
        imageChecked: _checked,
        ...attachment
      }) => attachment,
    ),
  };
}

export function parseDraftSnapshot(value: unknown) {
  if (value === null || value === undefined) return;
  const raw = record(decodeDraftAudio(value));
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
          "templateEdits",
        ].includes(key),
    )
  )
    throw new Error("unsupported draft format");
  // Validate the entire value before publishing any restored content.
  const composers = Object.entries(record(raw.composers)).map(
    ([key, item]) => [key, parseComposer(item)] as const,
  );
  const selected = parseChoice(raw.choice);
  const feedback = Object.entries(record(raw.feedback)).map(([key, items]) => {
    const entries = Object.entries(record(items)).map(([storedKey, item]) => {
      const itemValue = record(item);
      if (
        Object.keys(itemValue).some(
          (field) =>
            ![
              "path",
              "contentId",
              "text",
              "selection",
              "lineInput",
              "scope",
              "anchor",
            ].includes(field),
        ) ||
        (itemValue.path !== undefined && typeof itemValue.path !== "string") ||
        (itemValue.contentId !== undefined &&
          typeof itemValue.contentId !== "string") ||
        (itemValue.scope !== undefined &&
          itemValue.scope !== "file" &&
          itemValue.scope !== "fragment")
      )
        throw new Error("invalid feedback");
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
        (Object.keys(selection).some(
          (field) => !["side", "line", "endLine"].includes(field),
        ) ||
          !["before", "after"].includes(String(selection.side)) ||
          !Number.isSafeInteger(selection.line) ||
          Number(selection.line) < 1 ||
          (selection.endLine !== undefined &&
            (!Number.isSafeInteger(selection.endLine) ||
              Number(selection.endLine) < Number(selection.line))))
      )
        throw new Error("invalid line");
      const lineInput =
        itemValue.lineInput !== undefined
          ? record(itemValue.lineInput)
          : undefined;
      if (
        lineInput &&
        (Object.keys(lineInput).some(
          (field) => !["side", "text"].includes(field),
        ) ||
          !["before", "after"].includes(String(lineInput.side)) ||
          typeof lineInput.text !== "string")
      )
        throw new Error("invalid line input");
      const anchor = parseFeedbackAnchor(itemValue.anchor, {
        path,
        contentId,
        scope: itemValue.scope,
        selection,
        lineInput,
      });
      return [
        feedbackKey(path, contentId),
        {
          path,
          text: itemValue.text,
          selection,
          ...(lineInput ? { lineInput } : {}),
          ...(anchor ? { anchor } : {}),
          contentId,
          scope:
            itemValue.scope === "file" || itemValue.scope === "fragment"
              ? itemValue.scope
              : undefined,
        },
      ] as const;
    });
    return [
      key,
      Object.fromEntries(entries) as Record<string, SavedFileFeedback>,
    ] as const;
  });
  const queues = Object.entries(record(raw.queues)).map(([key, item]) => {
    const q = record(item);
    if (
      Object.keys(q).some(
        (field) =>
          !["blocks", "uncertainIndex", "outcomeUnknown"].includes(field),
      )
    )
      throw new Error("unsupported draft queue");
    if (q.outcomeUnknown !== undefined && typeof q.outcomeUnknown !== "boolean")
      throw new Error("invalid outcome notice");
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
  return {
    composers,
    selected,
    feedback,
    queues,
    activity: parseArchiveActivity(raw.activity),
    templateEdits: parseTemplateEdit(raw.templateEdits),
  };
}

draftPersistence.configure(
  () =>
    encodeDraftAudio({
      version: 1,
      composers: Object.fromEntries(
        [...values]
          .filter(
            ([key]) =>
              key === "new" ||
              key.startsWith("session:") ||
              key.startsWith("queue-edit:") ||
              key.startsWith("resend:") ||
              key.startsWith("saved-new:"),
          )
          .filter(
            ([key, draft]) =>
              queueHandoffDrafts.get(draft) !== key &&
              !isRestoredSource(key, draft),
          )
          .map(([key, value]) => [key, serializeComposer(value)]),
      ),
      choice,
      feedback: Object.fromEntries(feedbackValues),
      queues: Object.fromEntries(queueValues),
      activity: archiveActivity.snapshot(),
      ...(templateEditDrafts.read()
        ? { templateEdits: templateEditDrafts.read() }
        : {}),
    }),
  (value) => {
    const parsed = parseDraftSnapshot(value);
    if (!parsed) return;
    archiveActivity.restore(parsed.activity);
    restoreTemplateEdit(parsed.templateEdits);
    for (const [key, draft] of parsed.composers)
      if (!values.has(key)) values.set(key, draft);
    Object.assign(choice, parsed.selected);
    for (const [key, data] of parsed.feedback)
      if (!feedbackValues.has(key)) feedbackValues.set(key, data);
    for (const [key, data] of parsed.queues) {
      const current = queueValues.get(key);
      if (!current) queueValues.set(key, data);
      // A notice written before hydration must not hide the saved input. A
      // newer input wins otherwise, while either historical notice survives.
      else if (
        !current.blocks.length &&
        current.outcomeUnknown &&
        data.blocks.length
      )
        queueValues.set(key, { ...data, outcomeUnknown: true });
      else if (data.outcomeUnknown && !current.outcomeUnknown)
        queueValues.set(key, { ...current, outcomeUnknown: true });
    }
    draftRevision++;
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
