import { useEffect, useSyncExternalStore } from "react";
import { worktrees, type WorktreesSnapshot } from "./worktrees";
import type { WorktreeArchive, WorktreeRecovery } from "./worktree_types";

type Catalogue = Pick<
  WorktreesSnapshot,
  "ready" | "loading" | "error" | "archives"
> &
  Partial<Pick<WorktreesSnapshot, "recoveries">>;

function components(path: string): string[] | null {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\\"))
    return null;
  const parts = path.slice(1).split("/");
  return parts.every((part) => part && part !== "." && part !== "..")
    ? parts
    : null;
}

/** A catalogue association, not proof that either filesystem path exists now. */
export function findArchivedWorkLocation(
  state: Catalogue,
  cwd: string | null,
): WorktreeArchive | null {
  if (!cwd || !state.ready || state.loading || state.error) return null;
  const path = components(cwd);
  if (!path) return null;
  let found: WorktreeArchive | null = null;
  for (const archive of state.archives) {
    const root = components(archive.originalPath);
    if (
      !root ||
      root.length > path.length ||
      !root.every((part, i) => part === path[i])
    )
      continue;
    // Conflicting records do not establish which retained location to review.
    if (found) return null;
    found = archive;
  }
  return found;
}

export type WorkLocationGuidance =
  | { readonly kind: "archive"; readonly source: WorktreeArchive }
  | { readonly kind: "recovery"; readonly source: readonly WorktreeRecovery[] };
/** Associations only. Multiple backups stay in the manager; none is selected here. */
export function findWorkLocationGuidance(
  state: Catalogue,
  cwd: string | null,
): WorkLocationGuidance | null {
  if (!cwd || !state.ready || state.loading || state.error) return null;
  const path = components(cwd);
  if (!path) return null;
  const matches = (original: string) => {
    const root = components(original);
    return (
      root !== null &&
      root.length <= path.length &&
      root.every((p, i) => path[i] === p)
    );
  };
  const archives = state.archives.filter((a) => matches(a.originalPath));
  if (archives.length)
    return archives.length === 1
      ? { kind: "archive", source: archives[0] }
      : null;
  const recoveries = state.recoveries;
  return recoveries?.some((r) => matches(r.originalPath))
    ? { kind: "recovery", source: recoveries }
    : null;
}
export function currentWorkLocationGuidance(cwd: string | null) {
  return findWorkLocationGuidance(worktrees.snapshot(), cwd);
}
export function sameWorkLocationGuidance(
  a: WorkLocationGuidance | null,
  b: WorkLocationGuidance | null,
) {
  return a !== null && b !== null && a.kind === b.kind && a.source === b.source;
}
export function useWorkLocationGuidance(cwd: string | null, active: boolean) {
  const state = useSyncExternalStore(
    worktrees.subscribe,
    worktrees.snapshot,
    worktrees.snapshot,
  );
  useEffect(() => {
    if (active && cwd && !state.ready && !state.loading && !state.error)
      void worktrees.load();
  }, [active, cwd, state.ready, state.loading, state.error]);
  return active ? findWorkLocationGuidance(state, cwd) : null;
}
