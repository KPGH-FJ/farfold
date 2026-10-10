import { parseWorktreeLocation, type WorktreeLocation } from "./worktree_types";

export const PREPARATION_NAMES = {
  "package.json": "manifest",
  "pyproject.toml": "manifest",
  "requirements.txt": "manifest",
  Pipfile: "manifest",
  "Cargo.toml": "manifest",
  "go.mod": "manifest",
  "package-lock.json": "lock",
  "npm-shrinkwrap.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "uv.lock": "lock",
  "poetry.lock": "lock",
  "Pipfile.lock": "lock",
  "Cargo.lock": "lock",
  "go.sum": "lock",
  node_modules: "dependencyDirectory",
  ".venv": "dependencyDirectory",
  venv: "dependencyDirectory",
  target: "dependencyDirectory",
  vendor: "dependencyDirectory",
} as const;
export type PreparationName = keyof typeof PREPARATION_NAMES;
export type PreparationNodeKind =
  "missing" | "file" | "directory" | "symlink" | "other" | "unreadable";
export type PreparationFact = Readonly<{
  name: PreparationName;
  role: (typeof PREPARATION_NAMES)[PreparationName];
  nodeKind: PreparationNodeKind;
}>;
export type PreparationInspection = Readonly<{
  inspectionId: string;
  location: WorktreeLocation;
  projectRelativePath: string;
  projectPath: string;
  observedAtMs: number;
  git: Readonly<{ kind: "main" | "linked"; otherWorktreeCount: number }>;
  facts: readonly PreparationFact[];
  coverage: Readonly<{
    scope: "fixedNameMetadata";
    checkedNames: 22;
    complete: boolean;
  }>;
}>;

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Error("Invalid preparation receipt");
  return value as Record<string, unknown>;
}
function natural(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid preparation count");
  return value;
}
export function validPreparationSubdirectory(value: string): boolean {
  if (value === "") return true;
  const parts = value.split("/");
  return (
    new TextEncoder().encode(value).length <= 1024 &&
    parts.length <= 8 &&
    parts.every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git" &&
        !/[\\\p{Cc}]/u.test(part),
    )
  );
}
export function preparationProjectPath(root: string, relative: string): string {
  return relative ? `${root === "/" ? "" : root}/${relative}` : root;
}
export function samePreparationLocation(
  a: WorktreeLocation,
  b: WorktreeLocation,
): boolean {
  return (
    a.id === b.id &&
    a.revision === b.revision &&
    a.path === b.path &&
    a.repositoryRoot === b.repositoryRoot &&
    a.branch === b.branch &&
    a.headOid === b.headOid &&
    a.ownership === b.ownership &&
    a.availability === b.availability
  );
}
export function parsePreparationInspection(
  value: unknown,
  expected: WorktreeLocation,
  relative: string,
): PreparationInspection {
  const v = record(value, [
    "inspectionId",
    "location",
    "projectRelativePath",
    "projectPath",
    "observedAtMs",
    "git",
    "facts",
    "coverage",
  ]);
  const location = parseWorktreeLocation(v.location);
  if (
    location.availability !== "verified" ||
    !samePreparationLocation(location, expected) ||
    !validPreparationSubdirectory(relative) ||
    new TextEncoder().encode(preparationProjectPath(location.path, relative))
      .length > 4096 ||
    v.projectRelativePath !== relative ||
    v.projectPath !== preparationProjectPath(location.path, relative) ||
    typeof v.inspectionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      v.inspectionId,
    )
  )
    throw new Error("Mismatched preparation receipt");
  const git = record(v.git, ["kind", "otherWorktreeCount"]);
  if (
    (git.kind !== "main" && git.kind !== "linked") ||
    natural(git.otherWorktreeCount) > 255
  )
    throw new Error("Invalid repository kind");
  if (!Array.isArray(v.facts) || v.facts.length !== 22)
    throw new Error("Invalid preparation facts");
  const seen = new Set<string>();
  const facts = Array.from(v.facts, (value) => {
    const f = record(value, ["name", "role", "nodeKind"]);
    if (
      typeof f.name !== "string" ||
      !Object.hasOwn(PREPARATION_NAMES, f.name) ||
      seen.has(f.name)
    )
      throw new Error("Invalid preparation name");
    const name = f.name as PreparationName;
    if (
      f.role !== PREPARATION_NAMES[name] ||
      ![
        "missing",
        "file",
        "directory",
        "symlink",
        "other",
        "unreadable",
      ].includes(f.nodeKind as string)
    )
      throw new Error("Invalid preparation fact");
    seen.add(name);
    return Object.freeze({
      name,
      role: PREPARATION_NAMES[name],
      nodeKind: f.nodeKind as PreparationNodeKind,
    });
  });
  const coverage = record(v.coverage, ["scope", "checkedNames", "complete"]);
  if (
    coverage.scope !== "fixedNameMetadata" ||
    coverage.checkedNames !== 22 ||
    typeof coverage.complete !== "boolean" ||
    coverage.complete !== !facts.some((f) => f.nodeKind === "unreadable")
  )
    throw new Error("Invalid preparation coverage");
  return Object.freeze({
    inspectionId: v.inspectionId,
    location,
    projectRelativePath: relative,
    projectPath: v.projectPath as string,
    observedAtMs: natural(v.observedAtMs),
    git: Object.freeze({
      kind: git.kind,
      otherWorktreeCount: natural(git.otherWorktreeCount),
    }),
    facts: Object.freeze(facts),
    coverage: Object.freeze({
      scope: "fixedNameMetadata",
      checkedNames: 22,
      complete: coverage.complete,
    }),
  });
}
export function parsePreparationValidation(
  value: unknown,
  inspectionId: string,
): void {
  const v = record(value, ["inspectionId", "valid"]);
  if (v.inspectionId !== inspectionId || v.valid !== true)
    throw new Error("Invalid preparation validation");
}
