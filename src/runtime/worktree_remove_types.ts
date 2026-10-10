import type { WorktreeDraftBaseline } from "./worktree_recycle_types";
import type { WorktreeOperationBase } from "./worktree_types";
export type WorktreeRemoveInspection = Readonly<{
  inspectionId: string;
  action: "remove";
  recordId: string;
  revision: number;
  originalPath: string;
  retainedPath: string;
  repositoryRoot: string;
  headOid: string;
  branch: string | null;
  blockers: readonly string[];
  impact: Readonly<{ conversations: number; unsent: boolean }>;
  draftBaseline: WorktreeDraftBaseline;
  roots: Readonly<{
    count: number;
    sha256: string;
    objectFormat: "sha1" | "sha256";
  }>;
  content: Readonly<{ entries: number; bytes: number; sha256: string }>;
  localTracking: "noUpstream" | "ahead" | "localRecord" | "unknown";
}>;
export type WorktreeRecovery = Readonly<{
  id: string;
  revision: number;
  archiveId: string;
  archiveRevision: number;
  originalPath: string;
  retainedPath: string;
  repositoryRoot: string;
  headOid: string;
  branch: string | null;
  path: string;
  bundleBytes: number;
  bundleSha256: string;
  manifestSha256: string;
  rootsSha256: string;
  contentSha256: string;
  rootCount: number;
  objectCount: number;
  objectFormat: "sha1" | "sha256";
  availability: "verified" | "missing" | "changed" | "unknown";
}>;
export type WorktreeRemoved = Readonly<{
  recordId: string;
  revision: number;
  originalPath: string;
  retainedPath: string;
  recoveryId: string;
}>;
export type WorktreeRemovalPhase =
  | "preparingRecovery"
  | "verifyingRecovery"
  | "awaitingConfirmation"
  | "deleting"
  | "checkingOutcome"
  | "finished";
export type WorktreeRemovalOperation = WorktreeOperationBase &
  Readonly<{
    action: "remove";
    removalPhase: WorktreeRemovalPhase;
    deleteDispatched: boolean;
    recovery?: WorktreeRecovery;
    removed?: WorktreeRemoved;
    location?: never;
    archive?: never;
  }>;
const invalid = (): never => {
  throw new Error("Invalid worktree removal receipt");
};
const record = (
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return invalid();
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 4096): string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0")
    ? v
    : invalid();
const number = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : invalid();
const positive = (v: unknown): number => {
  const n = number(v);
  return n > 0 ? n : invalid();
};
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : invalid());
const sha = (v: unknown): string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : invalid();
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  return typeof v === "string" && allowed.includes(v as T)
    ? (v as T)
    : invalid();
}
function paths(v: Record<string, unknown>) {
  const originalPath = text(v.originalPath),
    retainedPath = text(v.retainedPath);
  if (originalPath === retainedPath) return invalid();
  return { originalPath, retainedPath };
}
function head(v: unknown, format: "sha1" | "sha256") {
  const value = text(v, 64);
  if (!(format === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value))
    return invalid();
  return value;
}
export function parseWorktreeRemoveInspection(
  raw: unknown,
): WorktreeRemoveInspection {
  const v = record(raw, [
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
    "draftBaseline",
    "roots",
    "content",
    "localTracking",
  ]);
  if (
    v.action !== "remove" ||
    !Array.isArray(v.blockers) ||
    v.blockers.length > 64
  )
    return invalid();
  const roots = record(v.roots, ["count", "sha256", "objectFormat"]),
    content = record(v.content, ["entries", "bytes", "sha256"]),
    impact = record(v.impact, ["conversations", "unsent"]),
    baseline = record(v.draftBaseline, ["unsentWork", "agentSetup"]);
  const objectFormat = oneOf(roots.objectFormat, ["sha1", "sha256"]);
  return Object.freeze({
    inspectionId: text(v.inspectionId, 128),
    action: "remove",
    recordId: text(v.recordId, 128),
    revision: number(v.revision),
    ...paths(v),
    repositoryRoot: text(v.repositoryRoot),
    headOid: head(v.headOid, objectFormat),
    branch: v.branch === null ? null : text(v.branch),
    blockers: Object.freeze(Array.from(v.blockers, (x) => text(x, 128))),
    impact: Object.freeze({
      conversations: number(impact.conversations),
      unsent: bool(impact.unsent),
    }),
    draftBaseline: Object.freeze({
      unsentWork:
        baseline.unsentWork === null ? null : sha(baseline.unsentWork),
      agentSetup:
        baseline.agentSetup === null ? null : sha(baseline.agentSetup),
    }),
    roots: Object.freeze({
      count: positive(roots.count),
      sha256: sha(roots.sha256),
      objectFormat,
    }),
    content: Object.freeze({
      entries: number(content.entries),
      bytes: number(content.bytes),
      sha256: sha(content.sha256),
    }),
    localTracking: oneOf(v.localTracking, [
      "noUpstream",
      "ahead",
      "localRecord",
      "unknown",
    ]),
  });
}
export function parseWorktreeRecovery(raw: unknown): WorktreeRecovery {
  const v = record(raw, [
    "id",
    "revision",
    "archiveId",
    "archiveRevision",
    "originalPath",
    "retainedPath",
    "repositoryRoot",
    "headOid",
    "branch",
    "path",
    "bundleBytes",
    "bundleSha256",
    "manifestSha256",
    "rootsSha256",
    "contentSha256",
    "rootCount",
    "objectCount",
    "objectFormat",
    "availability",
  ]);
  const objectFormat = oneOf(v.objectFormat, ["sha1", "sha256"]),
    rootCount = positive(v.rootCount),
    objectCount = positive(v.objectCount),
    p = paths(v),
    path = text(v.path);
  if (
    objectCount < rootCount ||
    path === p.originalPath ||
    path === p.retainedPath
  )
    return invalid();
  return Object.freeze({
    id: text(v.id, 128),
    revision: number(v.revision),
    archiveId: text(v.archiveId, 128),
    archiveRevision: number(v.archiveRevision),
    ...p,
    repositoryRoot: text(v.repositoryRoot),
    headOid: head(v.headOid, objectFormat),
    branch: v.branch === null ? null : text(v.branch),
    path,
    bundleBytes: positive(v.bundleBytes),
    bundleSha256: sha(v.bundleSha256),
    manifestSha256: sha(v.manifestSha256),
    rootsSha256: sha(v.rootsSha256),
    contentSha256: sha(v.contentSha256),
    rootCount,
    objectCount,
    objectFormat,
    availability: oneOf(v.availability, [
      "verified",
      "missing",
      "changed",
      "unknown",
    ]),
  });
}
export function parseWorktreeRemoval(
  raw: unknown,
  expectedId?: string,
): WorktreeRemovalOperation {
  const v = record(raw, [
    "kind",
    "operationId",
    "action",
    "state",
    "settled",
    "cancelRequested",
    "maintenanceActive",
    "code",
    "reviewed",
    "targetPath",
    "originalPath",
    "retainedPath",
    "removalPhase",
    "deleteDispatched",
    "recovery",
    "removed",
  ]);
  const operationId = text(v.operationId, 128);
  if (
    v.kind !== "operation" ||
    v.action !== "remove" ||
    (expectedId !== undefined && operationId !== expectedId)
  )
    return invalid();
  const state = oneOf(v.state, [
      "prepared",
      "running",
      "cancelling",
      "ready",
      "cancelled",
      "failed",
      "unknown",
    ]),
    settled = bool(v.settled),
    maintenanceActive = bool(v.maintenanceActive),
    cancelRequested = bool(v.cancelRequested),
    deleteDispatched = bool(v.deleteDispatched),
    removalPhase = oneOf(v.removalPhase, [
      "preparingRecovery",
      "verifyingRecovery",
      "awaitingConfirmation",
      "deleting",
      "checkingOutcome",
      "finished",
    ]);
  const p =
      v.originalPath === undefined && v.retainedPath === undefined
        ? undefined
        : paths(v),
    recovery =
      v.recovery === undefined ? undefined : parseWorktreeRecovery(v.recovery);
  const reviewed = v.reviewed === undefined ? undefined : bool(v.reviewed);
  if (
    (["prepared", "running", "cancelling"].includes(state) && settled) ||
    (["ready", "cancelled", "failed"].includes(state) && !settled) ||
    (reviewed && (state !== "unknown" || !settled)) ||
    ((state === "failed" || state === "cancelled") && deleteDispatched)
  )
    return invalid();
  if (
    (["deleting", "checkingOutcome"].includes(removalPhase) &&
      !deleteDispatched) ||
    ([
      "preparingRecovery",
      "verifyingRecovery",
      "awaitingConfirmation",
    ].includes(removalPhase) &&
      deleteDispatched)
  )
    return invalid();
  if (
    recovery &&
    (!p ||
      recovery.originalPath !== p.originalPath ||
      recovery.retainedPath !== p.retainedPath)
  )
    return invalid();
  if (
    state === "prepared" &&
    (removalPhase !== "awaitingConfirmation" ||
      deleteDispatched ||
      !maintenanceActive ||
      cancelRequested ||
      recovery?.availability !== "verified")
  )
    return invalid();
  let removed: WorktreeRemoved | undefined;
  if (v.removed !== undefined) {
    const r = record(v.removed, [
      "recordId",
      "revision",
      "originalPath",
      "retainedPath",
      "recoveryId",
    ]);
    removed = Object.freeze({
      recordId: text(r.recordId, 128),
      revision: number(r.revision),
      ...paths(r),
      recoveryId: text(r.recoveryId, 128),
    });
    if (
      !recovery ||
      removed.recordId !== recovery.archiveId ||
      removed.recoveryId !== recovery.id ||
      removed.revision < recovery.archiveRevision ||
      removed.originalPath !== p?.originalPath ||
      removed.retainedPath !== p?.retainedPath ||
      state !== "ready"
    )
      return invalid();
  }
  if (
    state === "ready" &&
    (!removed ||
      recovery?.availability !== "verified" ||
      removalPhase !== "finished" ||
      !deleteDispatched ||
      maintenanceActive)
  )
    return invalid();
  return Object.freeze({
    kind: "operation",
    operationId,
    action: "remove",
    state,
    settled,
    maintenanceActive,
    cancelRequested,
    deleteDispatched,
    removalPhase,
    ...p,
    ...(recovery ? { recovery } : {}),
    ...(removed ? { removed } : {}),
    ...(reviewed === undefined ? {} : { reviewed }),
    ...(v.code === undefined ? {} : { code: text(v.code, 128) }),
    ...(v.targetPath === undefined ? {} : { targetPath: text(v.targetPath) }),
  });
}
