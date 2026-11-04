import { draftPersistence } from "./draft_storage";

/** Latest organization metadata; serialized with unsent input, never a transcript. */
export interface ArchiveActivity {
  lastActivityAt: number;
  ended: boolean;
}
type Records = Record<string, ArchiveActivity>;
let records: Records = {};
let revision = 0;
const pending = new Map<string, number>();
const listeners = new Set<() => void>();

export function parseArchiveActivity(value: unknown): Records {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid archive metadata");
  const parsed: Records = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid archive metadata");
    const item = raw as ArchiveActivity;
    if (
      Object.keys(item).some(
        (field) => !["lastActivityAt", "ended"].includes(field),
      ) ||
      !Number.isFinite(item.lastActivityAt) ||
      item.lastActivityAt <= 0 ||
      typeof item.ended !== "boolean"
    )
      throw new Error("invalid archive metadata");
    parsed[key] = { lastActivityAt: item.lastActivityAt, ended: item.ended };
  }
  return parsed;
}

function stage(key: string, ended: boolean) {
  records = { ...records, [key]: { lastActivityAt: Date.now(), ended } };
  pending.set(key, ++revision);
}

async function flush() {
  const tickets = new Map(pending);
  await draftPersistence.flush();
  let committed = false;
  for (const [key, ticket] of tickets) {
    if (pending.get(key) !== ticket) continue;
    pending.delete(key);
    committed = true;
  }
  if (committed) listeners.forEach((listener) => listener());
}

async function update(key: string, ended?: boolean) {
  await draftPersistence.load();
  stage(key, ended ?? records[key]?.ended ?? false);
  draftPersistence.changed();
  await flush();
}

export const archiveActivity = {
  load: () => draftPersistence.load(),
  get: (key: string) => (pending.has(key) ? undefined : records[key]),
  revision: () => revision,
  flush,
  hasFailed: () =>
    pending.size > 0 && Boolean(draftPersistence.snapshot().error),
  retryFailed: flush,
  snapshot: () => records,
  /** Called by draft hydration only after every other field has validated. */
  restore(value: unknown) {
    const parsed = parseArchiveActivity(value);
    // Input edited before loading is never replaced by an older stored value.
    for (const key of pending.keys()) parsed[key] = records[key];
    records = parsed;
  },
  /** Called before the draft store publishes its one combined save snapshot. */
  stageDraftEdit(key: string) {
    stage(key, records[key]?.ended ?? false);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Save ended=false before dispatch; a failed save cannot admit a prompt. */
  begin: (key: string) => update(key, false),
  /** Only an observed real ending with no live tools may invoke this. */
  finish: (key: string) => update(key, true),
  /** Manual restore refreshes the wait without inventing an ending. */
  touch: (key: string) => update(key),
};
