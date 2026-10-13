// Owned parsing trees only: one text read, at most two text/render trees total.
// The PDF library's heap consumption is not certified by these leases.
let total = 0,
  inputs = 0;
export function tryAcquirePdfWorkerSlot(
  kind: "input" | "preview",
): (() => void) | null {
  if (total >= 2 || (kind === "input" && inputs >= 1)) return null;
  total++;
  if (kind === "input") inputs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    total--;
    if (kind === "input") inputs--;
  };
}
