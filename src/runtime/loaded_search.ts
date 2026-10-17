import { createLoadedSearchParser } from "./loaded_search_worker";
export { loadedMarkdownFields } from "./loaded_search_markdown";
import type { Attachment, ThreadItem, ThreadState } from "./session_types";
import { textImageParts } from "./text_image_links";
import { searchSnippetContext } from "./search_snippet";
import {
  checkedMessageContentOrder,
  type MessageContentOrderPart,
} from "./message_content_order";

type Message = Extract<ThreadItem, { kind: "user" | "agent" }>;
export type LoadedSearchHit = Readonly<{
  threadKey: string;
  itemId: string;
  role: "user" | "agent";
  attachmentIndex: number | null;
  query: string;
  before: string;
  match: string;
  after: string;
}>;
export type SelectLoadedSearch = (
  hit: LoadedSearchHit,
  current: () => boolean,
) => void;
export type LoadedSearchResult = Readonly<{
  hits: readonly LoadedSearchHit[];
  conversations: number;
  loaded: number;
  unloaded: number;
  unavailable: number;
  fields: number;
  skippedFields: number;
  matches: number;
  limited: boolean;
}>;
type Owner = {
  thread: ThreadState;
  item: Message;
  cwd: string;
  agentId: string;
  nativeSessionId: string;
  original: string;
  historical: boolean;
  bodyOrder: readonly MessageContentOrderPart[] | null;
  attachment?: Attachment;
  fieldIndex: number;
  field: string;
  start: number;
  end: number;
};
const owners = new WeakMap<LoadedSearchHit, Owner>();
// Search is temporary work, never a second transcript store. Budgeted omissions
// are reported, not counted as a complete search of those fields.
export const LOADED_SEARCH_LIMITS = {
  fieldCharacters: 1_048_576,
  characters: 16_777_216,
  hits: 200,
} as const;
function unavailable(state: ThreadState) {
  return !!state.historyUnavailable || state.reconnecting;
}
function bodyOrder(item: Message) {
  return item.kind === "agent"
    ? checkedMessageContentOrder(
        item.text.length,
        item.attachments?.length ?? 0,
        item.contentOrder,
      )
    : null;
}
function sameBodyOrder(
  a: readonly MessageContentOrderPart[] | null,
  b: readonly MessageContentOrderPart[] | null,
) {
  return a === null || b === null
    ? a === b
    : a.length === b.length &&
        a.every(
          (part, index) =>
            part.kind === b[index].kind &&
            part.start === b[index].start &&
            part.end === b[index].end,
        );
}
export function loadedSearchHitIsCurrent(
  hit: LoadedSearchHit,
  states: ReadonlyMap<string, ThreadState>,
  allowedKeys?: readonly string[],
): boolean {
  const owner = owners.get(hit);
  if (!owner || (allowedKeys && !allowedKeys.includes(hit.threadKey)))
    return false;
  const state = states.get(hit.threadKey);
  if (
    state !== owner.thread ||
    unavailable(state) ||
    state.key !== hit.threadKey ||
    state.cwd !== owner.cwd ||
    state.agentId !== owner.agentId ||
    state.nativeSessionId !== owner.nativeSessionId ||
    !state.items.includes(owner.item) ||
    owner.item.id !== hit.itemId
  )
    return false;
  if (hit.attachmentIndex !== null) {
    const attachment = owner.item.attachments?.[hit.attachmentIndex];
    return (
      attachment === owner.attachment && attachment?.text === owner.original
    );
  }
  return (
    owner.item.text === owner.original &&
    (owner.item.time === 0) === owner.historical &&
    sameBodyOrder(bodyOrder(owner.item), owner.bodyOrder)
  );
}
/** For a revalidated hit only; DOM still verifies this full field and offsets. */
export function loadedSearchHitField(hit: LoadedSearchHit) {
  const owner = owners.get(hit);
  return owner
    ? {
        index: owner.fieldIndex,
        text: owner.field,
        start: owner.start,
        end: owner.end,
      }
    : null;
}
export async function searchLoadedConversations(
  keys: readonly string[],
  states: ReadonlyMap<string, ThreadState>,
  query: string,
  options: {
    signal?: AbortSignal;
    yieldControl?: () => Promise<void>;
    parseMarkdown?: (text: string) => Promise<string[]>;
  } = {},
): Promise<LoadedSearchResult> {
  const result = {
    hits: [] as LoadedSearchHit[],
    conversations: 0,
    loaded: 0,
    unloaded: 0,
    unavailable: 0,
    fields: 0,
    skippedFields: 0,
    matches: 0,
    limited: false,
  };
  let characters = 0;
  let work = 0;
  const checkpoint = async (force = false) => {
    if (options.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (force || ++work % 32 === 0) {
      await (options.yieldControl?.() ??
        new Promise<void>((resolve) => setTimeout(resolve, 0)));
      if (options.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
    }
  };
  const needle = query.trim();
  if (needle.length > 512) throw new Error("Search query exceeds bound");
  const regex = new RegExp(
    needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const parser = options.parseMarkdown
    ? null
    : createLoadedSearchParser(options.signal);
  try {
    for (const key of new Set(keys)) {
      await checkpoint();
      result.conversations++;
      const thread = states.get(key);
      if (!thread) {
        result.unloaded++;
        continue;
      }
      if (unavailable(thread)) {
        result.unavailable++;
        continue;
      }
      result.loaded++;
      const identity = {
        cwd: thread.cwd,
        agentId: thread.agentId,
        nativeSessionId: thread.nativeSessionId,
      };
      if (!needle) continue;
      // Item references are a query snapshot, not copies of their bodies.
      for (const item of [...thread.items]) {
        if (item.kind !== "user" && item.kind !== "agent") continue;
        const historical = item.time === 0;
        // Snapshot only local presentation ranges, never media payloads. Value
        // copies also detect an in-place boundary change while parsing awaits.
        const order = bodyOrder(item)?.map((part) => ({ ...part })) ?? null;
        const inputs = [
          {
            original: item.text,
            attachmentIndex: null as number | null,
            attachment: undefined as Attachment | undefined,
          },
          ...(item.attachments ?? []).flatMap((attachment, index) =>
            typeof attachment.text === "string"
              ? [
                  {
                    original: attachment.text,
                    attachmentIndex: index,
                    attachment,
                  },
                ]
              : [],
          ),
        ];
        for (const input of inputs) {
          await checkpoint(true);
          if (
            input.original.length > LOADED_SEARCH_LIMITS.fieldCharacters ||
            characters + input.original.length > LOADED_SEARCH_LIMITS.characters
          ) {
            result.skippedFields++;
            continue;
          }
          characters += input.original.length;
          let fields: string[];
          if (input.attachment || (item.kind === "user" && !historical))
            fields = [input.original];
          else if (item.kind === "agent") {
            if (order === null)
              fields = await (options.parseMarkdown?.(input.original) ??
                parser!.parse(input.original));
            else {
              fields = [];
              for (const part of order) {
                if (part.kind !== "text") continue;
                await checkpoint(true);
                const text = input.original.slice(part.start, part.end);
                const parsed = await (options.parseMarkdown?.(text) ??
                  parser!.parse(text));
                // Each complete run uses the same Markdown pipeline as its
                // rendered counterpart. Never join text across a media gap.
                for (const field of parsed) fields.push(field);
              }
            }
          } else
            fields = textImageParts(input.original).flatMap((part) =>
              part.kind === "text" ? [part.text] : [],
            );
          await checkpoint();
          result.fields += fields.length;
          for (const [fieldIndex, field] of fields.entries()) {
            regex.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(field))) {
              result.matches++;
              if (result.hits.length < LOADED_SEARCH_LIMITS.hits) {
                const start = match.index,
                  end = start + match[0].length;
                const hit: LoadedSearchHit = Object.freeze({
                  threadKey: key,
                  itemId: item.id,
                  role: item.kind,
                  attachmentIndex: input.attachmentIndex,
                  query: needle,
                  ...searchSnippetContext(field, start, end),
                  match: match[0],
                });
                owners.set(hit, {
                  thread,
                  item,
                  ...identity,
                  original: input.original,
                  historical,
                  bodyOrder: input.attachment ? null : order,
                  attachment: input.attachment,
                  fieldIndex,
                  field,
                  start,
                  end,
                });
                result.hits.push(hit);
              }
              if (result.matches % 4096 === 0) await checkpoint(true);
            }
          }
        }
      }
    }
    result.limited =
      result.matches > result.hits.length || result.skippedFields > 0;
    return result;
  } finally {
    parser?.dispose();
  }
}
