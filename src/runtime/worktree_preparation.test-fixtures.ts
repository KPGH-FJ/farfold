import type { WorktreeLocation } from "./worktree_types";
import { PREPARATION_NAMES } from "./worktree_preparation_types";
export const preparationLocation = Object.freeze({
  id: "created-one",
  revision: 0,
  path: "/repo/tree",
  repositoryRoot: "/repo",
  branch: "feature",
  headOid: "a".repeat(40),
  ownership: "created",
  availability: "verified",
} as const);
/** Deliberate protocol fixture, not an actual Git/OS receipt. */
export const preparationWire = () => ({
  inspectionId: "88abb8ca-6f07-448c-8482-a757c7944d62",
  location: { ...preparationLocation } as {
    -readonly [K in keyof WorktreeLocation]: WorktreeLocation[K];
  },
  projectRelativePath: "",
  projectPath: "/repo/tree",
  observedAtMs: 1800000000000,
  git: { kind: "linked", otherWorktreeCount: 1 },
  facts: Object.entries(PREPARATION_NAMES).map(([name, role]) => ({
    name,
    role,
    nodeKind: name === "package.json" ? "file" : "missing",
  })),
  coverage: { scope: "fixedNameMetadata", checkedNames: 22, complete: true },
});
