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
