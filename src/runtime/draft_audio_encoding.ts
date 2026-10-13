import { DRAFT_STRINGS } from "./draft_storage";

// Snapshot-local encoding only: no file, identity, source authority or separate
// storage. Existing settings_set still replaces the complete draft atomically.
export const MAX_AUDIO_REFERENCES = 256;
export const MAX_AUDIO_EXPANDED_BYTES = 96 * 1024 * 1024;
const MAX_ENCODED_BYTES = 32 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function invalid(): never {
  throw new Error("invalid draft audio encoding");
}
function tooLarge(): never {
  throw new Error(DRAFT_STRINGS.tooLarge);
}

/** Only declared audio.data fields in the existing unsent-work schema. */
function mapAudio(value: RecordValue, transform: (data: unknown) => unknown) {
  const block = (item: unknown, tag: "kind" | "type") =>
    record(item) && item[tag] === "audio" && item.data !== undefined
      ? { ...item, data: transform(item.data) }
      : item;
  const blocks = (items: unknown) =>
    Array.isArray(items) ? items.map((item) => block(item, "type")) : items;
  return {
    ...value,
    ...(record(value.composers)
      ? {
          composers: Object.fromEntries(
            Object.entries(value.composers).map(([key, draft]) => [
              key,
              record(draft)
                ? {
                    ...draft,
                    ...(Array.isArray(draft.attachments)
                      ? {
                          attachments: draft.attachments.map((item) =>
                            block(item, "kind"),
                          ),
                        }
                      : {}),
                    ...(record(draft.queueEdit)
                      ? {
                          queueEdit: {
                            ...draft.queueEdit,
                            original: blocks(draft.queueEdit.original),
                          },
                        }
                      : {}),
                  }
                : draft,
            ]),
          ),
        }
      : {}),
    ...(record(value.queues)
      ? {
          queues: Object.fromEntries(
            Object.entries(value.queues).map(([key, queue]) => [
              key,
              record(queue) && Array.isArray(queue.blocks)
                ? {
                    ...queue,
                    blocks: queue.blocks.map(blocks),
                  }
                : queue,
            ]),
          ),
        }
      : {}),
  };
}

export function encodeDraftAudio(value: unknown): unknown {
  if (!record(value) || value.audioEncoding !== undefined) invalid();
  const counts = new Map<string, number>();
  mapAudio(value, (data) => {
    if (typeof data !== "string") invalid();
    counts.set(data, (counts.get(data) ?? 0) + 1);
    return data;
  });
  if (![...counts.values()].some((count) => count > 1)) return value;
  const values: string[] = [],
    indices = new Map<string, number>();
  let references = 0;
  const encoded = mapAudio(value, (data) => {
    if (typeof data !== "string") invalid();
    if (++references > MAX_AUDIO_REFERENCES) tooLarge();
    let index = indices.get(data);
    if (index === undefined) {
      index = values.length;
      values.push(data);
      indices.set(data, index);
    }
    return { audioRef: index };
  });
  const result = { ...encoded, audioEncoding: { version: 1, values } };
  if (bytes(result) > MAX_ENCODED_BYTES) tooLarge();
  let expanded = bytes(encoded);
  const sizes = values.map(bytes);
  mapAudio(encoded, (data) => {
    const index = (data as { audioRef: number }).audioRef;
    expanded += sizes[index] - bytes(data);
    return data;
  });
  if (expanded > MAX_AUDIO_EXPANDED_BYTES) tooLarge();
  return result;
}

/** Validate the whole encoded snapshot before the existing parser publishes any
 * restored draft. JSON round-trip also isolates metadata objects and rejects
 * cycles; references cannot resolve outside this one snapshot. */
export function decodeDraftAudio(value: unknown): unknown {
  if (!record(value) || value.audioEncoding === undefined) return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    invalid();
  }
  if (new TextEncoder().encode(json).byteLength > MAX_ENCODED_BYTES) invalid();
  const cloned = JSON.parse(json) as RecordValue;
  const encoding = cloned.audioEncoding;
  if (
    !record(encoding) ||
    encoding.version !== 1 ||
    Object.keys(encoding).some(
      (key) => key !== "version" && key !== "values",
    ) ||
    !Array.isArray(encoding.values) ||
    encoding.values.length < 1 ||
    encoding.values.length > MAX_AUDIO_REFERENCES ||
    encoding.values.some((value) => typeof value !== "string")
  )
    invalid();
  const values = encoding.values as string[];
  if (new Set(values).size !== values.length) invalid();
  delete cloned.audioEncoding;
  let expanded = bytes(cloned),
    references = 0;
  const used = new Set<number>(),
    sizes = values.map(bytes);
  mapAudio(cloned, (data) => {
    if (
      !record(data) ||
      Object.keys(data).length !== 1 ||
      !Number.isSafeInteger(data.audioRef) ||
      Number(data.audioRef) < 0 ||
      Number(data.audioRef) >= values.length
    )
      invalid();
    if (++references > MAX_AUDIO_REFERENCES) invalid();
    const index = data.audioRef as number;
    expanded += sizes[index] - bytes(data);
    used.add(index);
    return data;
  });
  if (used.size !== values.length || expanded > MAX_AUDIO_EXPANDED_BYTES)
    invalid();
  return mapAudio(
    cloned,
    (data) => values[(data as { audioRef: number }).audioRef],
  );
}
