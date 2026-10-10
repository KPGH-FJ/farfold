import {
  parseWorktreeArchive,
  type WorktreeArchive,
} from "./worktree_recycle_types";
export * from "./worktree_recycle_types";
/** Public, bounded DTOs. Inspection tickets are transient, never conversation identities. */
export type WorktreeLocation = Readonly<{
  id: string;
  revision: number;
  path: string;
  repositoryRoot: string;
  branch: string | null;
  headOid: string;
  ownership: "created" | "existing";
  availability: "verified" | "missing" | "changed" | "unknown";
}>;
export type WorktreeInspection = Readonly<{
  inspectionId: string;
  root: string;
  repositoryRoot: string;
  kind: "main" | "linked";
  head: Readonly<{ oid: string | null; branch: string | null }>;
  trees: readonly Readonly<{
    locationId?: string;
    path: string;
    branch: string | null;
    locked: boolean;
  }>[];
  blockers: readonly string[];
}>;
export type WorktreeRef = Readonly<{
  ref: string;
  oid: string;
  inUse: boolean;
}>;
export type WorktreeRefs = Readonly<{
  refs: readonly WorktreeRef[];
  nextCursor: string | null;
}>;
export type WorktreeCreate = Readonly<{
  inspectionId: string;
  parentPath: string;
  directoryName: string;
  branch:
    | Readonly<{ kind: "new"; name: string; startOid: string }>
    | Readonly<{ kind: "existing"; ref: string; expectedOid: string }>;
}>;
export type WorktreeOperation = Readonly<{
  kind: "operation";
  operationId: string;
  action: "create" | "adopt" | "archive" | "restore";
  maintenanceActive: boolean;
  state:
    | "prepared"
    | "running"
    | "cancelling"
    | "ready"
    | "cancelled"
    | "failed"
    | "unknown";
  settled: boolean;
  cancelRequested: boolean;
  location?: WorktreeLocation;
  code?: string;
  reviewed?: boolean;
  targetPath?: string;
  originalPath?: string;
  retainedPath?: string;
  archive?: WorktreeArchive;
}>;
export type WorktreeReply =
  | WorktreeOperation
  | Readonly<{ kind: "unknownOperation"; operationId: string }>;
export type WorktreeList = Readonly<{
  locations: readonly WorktreeLocation[];
  archives: readonly WorktreeArchive[];
  materials: readonly WorktreeMaterial[];
  operation: WorktreeOperation | null;
}>;
export type WorktreeMaterial = Readonly<{
  operationId: string;
  path: string;
  repositoryRoot: string;
}>;

const record = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid worktree receipt");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 4096): string => {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error("Invalid worktree text");
  return value;
};
const nullable = (value: unknown) => (value === null ? null : text(value));
const bool = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new Error("Invalid worktree flag");
  return value;
};
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T => {
  if (!options.includes(value as T)) throw new Error("Invalid worktree state");
  return value as T;
};
const array = <T>(
  value: unknown,
  limit: number,
  parse: (v: unknown) => T,
): readonly T[] => {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error("Invalid worktree list");
  return Object.freeze(Array.from(value, parse));
};
const oid = (value: unknown) => {
  const result = text(value, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result))
    throw new Error("Invalid commit");
  return result;
};
export function parseWorktreeLocation(value: unknown): WorktreeLocation {
  const v = record(value, [
    "id",
    "revision",
    "path",
    "repositoryRoot",
    "branch",
    "headOid",
    "ownership",
    "availability",
  ]);
  if (!Number.isSafeInteger(v.revision) || (v.revision as number) < 0)
    throw new Error("Invalid revision");
  return Object.freeze({
    id: text(v.id, 128),
    revision: v.revision as number,
    path: text(v.path),
    repositoryRoot: text(v.repositoryRoot),
    branch: nullable(v.branch),
    headOid: oid(v.headOid),
    ownership: oneOf(v.ownership, ["created", "existing"]),
    availability: oneOf(v.availability, [
      "verified",
      "missing",
      "changed",
      "unknown",
    ]),
  });
}
export function parseWorktreeInspection(value: unknown): WorktreeInspection {
  const v = record(value, [
    "inspectionId",
    "root",
    "repositoryRoot",
    "kind",
    "head",
    "trees",
    "blockers",
  ]);
  const head = record(v.head, ["oid", "branch"]);
  return Object.freeze({
    inspectionId: text(v.inspectionId, 128),
    root: text(v.root),
    repositoryRoot: text(v.repositoryRoot),
    kind: oneOf(v.kind, ["main", "linked"]),
    head: Object.freeze({
      oid: head.oid === null ? null : oid(head.oid),
      branch: nullable(head.branch),
    }),
    trees: array(v.trees, 256, (item) => {
      const t = record(item, ["locationId", "path", "branch", "locked"]);
      return Object.freeze({
        ...(t.locationId === undefined
          ? {}
          : { locationId: text(t.locationId, 128) }),
        path: text(t.path),
        branch: nullable(t.branch),
        locked: bool(t.locked),
      });
    }),
    blockers: array(v.blockers, 64, (item) => text(item, 128)),
  });
}
export function parseWorktreeRefs(value: unknown): WorktreeRefs {
  const v = record(value, ["refs", "nextCursor"]);
  return Object.freeze({
    refs: array(v.refs, 100, (item) => {
      const r = record(item, ["ref", "oid", "inUse"]);
      return Object.freeze({
        ref: text(r.ref),
        oid: oid(r.oid),
        inUse: bool(r.inUse),
      });
    }),
    nextCursor: v.nextCursor === null ? null : text(v.nextCursor, 1024),
  });
}
export function parseWorktreeReply(
  value: unknown,
  expectedId?: string,
): WorktreeReply {
  const v = record(value, [
    "kind",
    "operationId",
    "state",
    "settled",
    "cancelRequested",
    "location",
    "code",
    "reviewed",
    "targetPath",
    "action",
    "maintenanceActive",
    "originalPath",
    "retainedPath",
    "archive",
  ]);
  const operationId = text(v.operationId, 128);
  if (expectedId !== undefined && operationId !== expectedId)
    throw new Error("Wrong operation");
  if (v.kind === "unknownOperation") {
    record(value, ["kind", "operationId"]);
    return Object.freeze({ kind: "unknownOperation", operationId });
  }
  if (v.kind !== "operation") throw new Error("Invalid operation");
  const action = oneOf(v.action, ["create", "adopt", "archive", "restore"]);
  const maintenanceActive = bool(v.maintenanceActive);
  const recycle = action === "archive" || action === "restore";
  const archive =
    v.archive === undefined ? undefined : parseWorktreeArchive(v.archive);
  const originalPath =
    v.originalPath === undefined ? undefined : text(v.originalPath);
  const retainedPath =
    v.retainedPath === undefined ? undefined : text(v.retainedPath);
  if (
    (!recycle &&
      (maintenanceActive || archive || originalPath || retainedPath)) ||
    Boolean(originalPath) !== Boolean(retainedPath) ||
    (originalPath && originalPath === retainedPath) ||
    (archive && action !== "archive")
  )
    throw new Error("Invalid maintenance result");
  const state = oneOf(v.state, [
    "prepared",
    "running",
    "cancelling",
    "ready",
    "cancelled",
    "failed",
    "unknown",
  ]);
  if (recycle && state === "prepared" && !maintenanceActive)
    throw new Error("Prepared maintenance is not held");
  const settled = bool(v.settled);
  const reviewed = v.reviewed === undefined ? undefined : bool(v.reviewed);
  if (reviewed && (state !== "unknown" || !settled))
    throw new Error("Invalid review");
  if (
    (["prepared", "running", "cancelling"].includes(state) && settled) ||
    (["ready", "cancelled", "failed"].includes(state) && !settled)
  )
    throw new Error("Invalid completion");
  const location =
    v.location === undefined ? undefined : parseWorktreeLocation(v.location);
  if (action === "archive" && location)
    throw new Error("Archive is not usable");
  if (
    state === "ready" &&
    (action === "archive"
      ? !archive ||
        archive.availability !== "verified" ||
        location ||
        archive.originalPath !== originalPath ||
        archive.retainedPath !== retainedPath
      : !location ||
        location.availability !== "verified" ||
        (action === "restore" &&
          (!originalPath ||
            !retainedPath ||
            location.path !== originalPath ||
            location.ownership !== "created")))
  )
    throw new Error("Unverified result");
  return Object.freeze({
    kind: "operation",
    operationId,
    action,
    maintenanceActive,
    state,
    settled,
    cancelRequested: bool(v.cancelRequested),
    ...(location ? { location } : {}),
    ...(archive ? { archive } : {}),
    ...(originalPath ? { originalPath, retainedPath } : {}),
    ...(v.code === undefined ? {} : { code: text(v.code, 128) }),
    ...(reviewed === undefined ? {} : { reviewed }),
    ...(v.targetPath === undefined ? {} : { targetPath: text(v.targetPath) }),
  });
}
export function parseWorktreeList(value: unknown): WorktreeList {
  const v = record(value, ["locations", "operation", "materials", "archives"]);
  const locations = array(v.locations, 256, parseWorktreeLocation);
  const archives = array(v.archives, 256, parseWorktreeArchive);
  if (
    new Set(archives.map((a) => a.id)).size !== archives.length ||
    archives.some((a) => locations.some((l) => l.id === a.id))
  )
    throw new Error("Conflicting archive records");
  if (new Set(locations.map((item) => item.id)).size !== locations.length)
    throw new Error("Duplicate location");
  const operation =
    v.operation === null ? null : parseWorktreeReply(v.operation);
  if (operation?.kind === "unknownOperation")
    throw new Error("Invalid current intent");
  const materials = array(v.materials, 256, (raw) => {
    const m = record(raw, ["operationId", "path", "repositoryRoot"]);
    return Object.freeze({
      operationId: text(m.operationId, 128),
      path: text(m.path),
      repositoryRoot: text(m.repositoryRoot),
    });
  });
  return Object.freeze({ locations, archives, operation, materials });
}
