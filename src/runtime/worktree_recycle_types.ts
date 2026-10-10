export type WorktreeArchive = Readonly<{
  id: string;
  revision: number;
  originalPath: string;
  retainedPath: string;
  repositoryRoot: string;
  branch: string | null;
  headOid: string;
  ownership: "created";
  availability: "verified" | "missing" | "changed" | "unknown";
}>;
export type WorktreeDraftBaseline = Readonly<{
  unsentWork: string | null;
  agentSetup: string | null;
}>;
export type WorktreeRecycleAction = "archive" | "restore";
export type WorktreeRecycleInspection = Readonly<{
  inspectionId: string;
  action: WorktreeRecycleAction;
  recordId: string;
  revision: number;
  originalPath: string;
  retainedPath: string;
  repositoryRoot: string;
  headOid: string;
  branch: string | null;
  blockers: readonly string[];
  impact: Readonly<{ conversations: number; unsent: boolean }>;
  material: Readonly<{ entries: number; bytes: number; sha256: string }>;
  draftBaseline: WorktreeDraftBaseline;
}>;
const invalid = () => {
  throw new Error("Invalid worktree maintenance receipt");
};
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return invalid();
  return v as Record<string, unknown>;
}
function text(v: unknown, max = 4096): string {
  return typeof v === "string" &&
    v.length > 0 &&
    v.length <= max &&
    !v.includes("\0")
    ? v
    : invalid();
}
function number(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : invalid();
}
function sha(v: unknown): string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : invalid();
}
function oid(v: unknown): string {
  return typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v)
    ? v
    : invalid();
}
export function parseWorktreeArchive(value: unknown): WorktreeArchive {
  const v = record(value, [
    "id",
    "revision",
    "originalPath",
    "retainedPath",
    "repositoryRoot",
    "branch",
    "headOid",
    "ownership",
    "availability",
  ]);
  if (
    v.ownership !== "created" ||
    typeof v.availability !== "string" ||
    !["verified", "missing", "changed", "unknown"].includes(v.availability)
  )
    return invalid();
  const originalPath = text(v.originalPath),
    retainedPath = text(v.retainedPath);
  if (originalPath === retainedPath) return invalid();
  return Object.freeze({
    id: text(v.id, 128),
    revision: number(v.revision),
    originalPath,
    retainedPath,
    repositoryRoot: text(v.repositoryRoot),
    branch: v.branch === null ? null : text(v.branch),
    headOid: oid(v.headOid),
    ownership: "created",
    availability: v.availability as WorktreeArchive["availability"],
  });
}
export function parseWorktreeRecycleInspection(
  value: unknown,
): WorktreeRecycleInspection {
  const v = record(value, [
    "inspectionId",
    "action",
    "recordId",
    "revision",
    "originalPath",
    "retainedPath",
    "repositoryRoot",
    "headOid",
    "branch",
    "blockers",
    "impact",
    "material",
    "draftBaseline",
  ]);
  if (v.action !== "archive" && v.action !== "restore") return invalid();
  if (!Array.isArray(v.blockers) || v.blockers.length > 64) return invalid();
  const impact = record(v.impact, ["conversations", "unsent"]),
    material = record(v.material, ["entries", "bytes", "sha256"]),
    baseline = record(v.draftBaseline, ["unsentWork", "agentSetup"]);
  if (typeof impact.unsent !== "boolean") return invalid();
  const originalPath = text(v.originalPath),
    retainedPath = text(v.retainedPath);
  if (originalPath === retainedPath) return invalid();
  return Object.freeze({
    inspectionId: text(v.inspectionId, 128),
    action: v.action,
    recordId: text(v.recordId, 128),
    revision: number(v.revision),
    originalPath,
    retainedPath,
    repositoryRoot: text(v.repositoryRoot),
    headOid: oid(v.headOid),
    branch: v.branch === null ? null : text(v.branch),
    blockers: Object.freeze(Array.from(v.blockers, (v) => text(v, 128))),
    impact: Object.freeze({
      conversations: number(impact.conversations),
      unsent: impact.unsent,
    }),
    material: Object.freeze({
      entries: number(material.entries),
      bytes: number(material.bytes),
      sha256: sha(material.sha256),
    }),
    draftBaseline: Object.freeze({
      unsentWork:
        baseline.unsentWork === null ? null : sha(baseline.unsentWork),
      agentSetup:
        baseline.agentSetup === null ? null : sha(baseline.agentSetup),
    }),
  });
}
