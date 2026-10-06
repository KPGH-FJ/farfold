import type { ThreadItem } from "./session_types";

/** Only explicitly marked out-of-band notifications are transparent. Stop at
 * the first other item; callers still check its role and streaming state. */
export function streamTailItem(
  items: readonly ThreadItem[],
): ThreadItem | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "raw" && item.streamNeutral === true) continue;
    return item;
  }
  return undefined;
}
