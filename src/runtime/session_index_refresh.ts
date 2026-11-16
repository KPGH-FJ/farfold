import { sameConfigurationSnapshot } from "./config_check";
import type { IndexRow } from "./sessions";

/** Reuse only the current row when every JSON field still agrees. No history
 * of removed or changed rows is retained, so returning values cannot revive
 * the authority of an earlier row. Call after the IPC response arrives. */
export function retainIndexRows(
  previous: readonly IndexRow[],
  next: IndexRow[],
) {
  const current = new Map(previous.map((row) => [row.id, row]));
  return next.map((row) => {
    const prior = current.get(row.id);
    return prior && sameConfigurationSnapshot(prior, row) ? prior : row;
  });
}

/** A response that crossed another index change cannot replace that newer
 * publication. Read the local store again, rather than guessing freshness
 * from request start order or discarding rows created by an overlapping open.
 * If that one extra read also crosses a change, keep the current index. */
export async function refreshIndexRows(
  read: () => Promise<IndexRow[]>,
  current: () => readonly IndexRow[],
  publish: (rows: IndexRow[]) => void,
): Promise<readonly IndexRow[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = current();
    const rows = await read();
    const latest = current();
    if (before !== latest) continue;
    const next = retainIndexRows(latest, rows);
    // Equal responses preserve the current array as well as each row. Real
    // membership ABA still changes its identity even when neighbours survive.
    if (
      next.length !== latest.length ||
      next.some((row, index) => row !== latest[index])
    ) {
      publish(next);
      return next;
    }
    return latest;
  }
  return null;
}

/** Recovery can interpret a missing row only after an accepted local read.
 * The sidebar keeps its previous rows independently of read failures. */
export function createSessionIndexReader(
  read: () => Promise<IndexRow[]>,
  current: () => readonly IndexRow[],
  publish: (rows: IndexRow[]) => void,
) {
  let confirmed: readonly IndexRow[] | null = null;
  let latest: object | null = null;
  return {
    ready: () => confirmed === current(),
    async refresh() {
      const request = {};
      latest = request;
      let accepted: readonly IndexRow[] | null = null;
      try {
        accepted = await refreshIndexRows(read, current, publish);
      } finally {
        if (latest === request) confirmed = accepted;
      }
    },
  };
}
