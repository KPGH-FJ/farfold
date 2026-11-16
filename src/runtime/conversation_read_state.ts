import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { LIBRARY } from "./library_strings";
import {
  attachmentMediaPreviewEligibility,
  hasReadableMessages,
  normalizeMessageAttachment,
  sameOfficialAttachment,
} from "./message_attachments";
import type { Attachment, ThreadState, ToolContent } from "./session_types";

const SETTINGS_KEY = "conversationReadState.v1";
interface ReadState {
  unread: ReadonlySet<string>;
  ready: boolean;
  saving: boolean;
  error: string | null;
}

function parse(value: unknown): Set<string> {
  if (value == null) return new Set();
  const data = value as { version?: unknown; unread?: unknown };
  if (
    data.version !== 1 ||
    !Array.isArray(data.unread) ||
    data.unread.some((key) => typeof key !== "string" || !key)
  )
    throw new Error(LIBRARY.unreadLoadError);
  return new Set(data.unread);
}

/** Organization metadata only: one unread bit per conversation, no messages or events. */
let state: ReadState = {
  unread: new Set(),
  ready: false,
  saving: false,
  error: null,
};
let visibleKey: string | null = null;
let visibleRegistration: object | null = null;
let revision = 0;
const pending = new Map<string, { unread: boolean; revision: number }>();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
function publish(next: ReadState) {
  state = next;
  listeners.forEach((listener) => listener());
}

async function load() {
  if (state.ready) return;
  return (loading ??= (async () => {
    try {
      const unread = parse(await invoke("settings_get", { key: SETTINGS_KEY }));
      // A reply or opening observed during hydration wins over older metadata.
      for (const [key, edit] of pending)
        if (edit.unread) unread.add(key);
        else unread.delete(key);
      publish({ ...state, unread, ready: true, error: null });
    } catch {
      publish({ ...state, error: LIBRARY.unreadLoadError });
      throw new Error(LIBRARY.unreadLoadError);
    } finally {
      loading = null;
    }
  })());
}

function flush(): Promise<void> {
  const operation = writes
    .catch(() => undefined)
    .then(async () => {
      await load();
      try {
        while (pending.size) {
          const saved = new Map(pending);
          const value = { version: 1, unread: [...state.unread] };
          publish({ ...state, saving: true, error: null });
          await invoke("settings_set", { key: SETTINGS_KEY, value });
          for (const [key, edit] of saved)
            if (pending.get(key)?.revision === edit.revision)
              pending.delete(key);
        }
        publish({ ...state, saving: false, error: null });
      } catch {
        publish({ ...state, saving: false, error: LIBRARY.unreadSaveError });
        throw new Error(LIBRARY.unreadSaveError);
      }
    });
  writes = operation;
  return operation;
}

function change(key: string, unread: boolean) {
  if (
    !key ||
    pending.get(key)?.unread === unread ||
    (state.ready && state.unread.has(key) === unread)
  )
    return;
  const next = new Set(state.unread);
  if (unread) next.add(key);
  else next.delete(key);
  pending.set(key, { unread, revision: ++revision });
  publish({ ...state, unread: next });
  void flush().catch(() => undefined);
}

/** Only the common, bounded inline-media presentation can make a tool result
 * readable. Progress, raw output, text, URLs and rejected media stay separate. */
function readableToolMedia(content: readonly ToolContent[]): Attachment[] {
  return content.flatMap((block) =>
    block.type === "attachment" &&
    (block.attachment.kind === "image" || block.attachment.kind === "audio") &&
    attachmentMediaPreviewEligibility(block.attachment).status === "eligible"
      ? [block.attachment]
      : [],
  );
}

export const conversationReadState = {
  snapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  load,
  flush,
  hasPending: () => pending.size > 0,
  flushPending: () => (pending.size ? flush() : Promise.resolve()),
  setVisible(key: string | null, readable = true) {
    visibleKey = readable ? key : null;
    if (key && readable) change(key, false);
  },
  receiveUpdate(key: string, update: unknown) {
    const value = update as {
      sessionUpdate?: unknown;
      content?: unknown;
    } | null;
    if (value?.sessionUpdate !== "agent_message_chunk") return;
    const content = value.content as { type?: unknown; text?: unknown } | null;
    const readable =
      (content?.type === "text" &&
        typeof content.text === "string" &&
        !!content.text.trim()) ||
      !!normalizeMessageAttachment(content);
    if (readable) change(key, key !== visibleKey);
  },
  receiveToolMedia(
    key: string,
    previous: readonly ToolContent[],
    current: readonly ToolContent[],
  ) {
    const before = readableToolMedia(previous);
    if (
      readableToolMedia(current).some(
        (attachment) =>
          !before.some(
            (old) =>
              old === attachment || sameOfficialAttachment(old, attachment),
          ),
      )
    )
      change(key, key !== visibleKey);
  },
};

export function canMarkConversationRead(
  thread:
    | Pick<
        ThreadState,
        "items" | "openError" | "reconnecting" | "unrecoverable"
      >
    | undefined
    | null,
): boolean {
  return (
    !!thread &&
    !thread.openError &&
    !thread.reconnecting &&
    !thread.unrecoverable &&
    (hasReadableMessages(
      thread.items.filter((item) => item.kind === "agent"),
    ) ||
      thread.items.some(
        (item) =>
          item.kind === "tool" &&
          readableToolMedia(item.call.content).length > 0,
      ))
  );
}

export function useConversationReadState() {
  const snapshot = useSyncExternalStore(
    conversationReadState.subscribe,
    conversationReadState.snapshot,
    conversationReadState.snapshot,
  );
  useEffect(() => {
    void load().catch(() => undefined);
  }, []);
  return snapshot;
}

/** A hidden page never consumes a reply. Failed/empty history does not mark it read. */
export function useVisibleConversation(key: string | null, readable: boolean) {
  useEffect(() => {
    // Retained pages can receive replies while another conversation is shown.
    if (!key || !readable) return;
    const registration = {};
    visibleRegistration = registration;
    const sync = () => {
      if (visibleRegistration !== registration) return;
      conversationReadState.setVisible(
        typeof document === "undefined" || !document.hidden ? key : null,
      );
    };
    sync();
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", sync);
    return () => {
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", sync);
      if (visibleRegistration === registration) {
        visibleRegistration = null;
        conversationReadState.setVisible(null);
      }
    };
  }, [key, readable]);
}
