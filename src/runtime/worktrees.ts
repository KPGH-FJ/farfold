import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";
import { draftPersistence } from "./draft_storage";
import { setupStorage } from "./setup_storage";
import { threads } from "./sessions";
import {
  WORKTREE_STRINGS as S,
  worktreeFailureMessage,
} from "./worktree_strings";
import {
  parseWorktreeInspection,
  parseWorktreeList,
  parseWorktreeLocation,
  parseWorktreeRefs,
  parseWorktreeReply,
  parseWorktreeRecycleInspection,
  type WorktreeCreate,
  type WorktreeLocation,
  type WorktreeMaterial,
  type WorktreeReply,
  type WorktreeArchive,
  type WorktreeRecycleAction,
  type WorktreeRecycleInspection,
} from "./worktree_types";

export type WorktreesSnapshot = Readonly<{
  locations: readonly WorktreeLocation[];
  materials: readonly WorktreeMaterial[];
  archives: readonly WorktreeArchive[];
  maintenanceLocked: boolean;
  ready: boolean;
  loading: boolean;
  working: boolean;
  operationId: string | null;
  operation: WorktreeReply | null;
  uncertain: boolean;
  error: string | null;
}>;
let snapshot: WorktreesSnapshot = Object.freeze({
  locations: [],
  materials: [],
  archives: [],
  maintenanceLocked: false,
  ready: false,
  loading: false,
  working: false,
  operationId: null,
  operation: null,
  uncertain: false,
  error: null,
});
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;
let intent: {
  id: string;
  action: "create" | "adopt" | "archive" | "restore";
  recycle?: WorktreeRecycleInspection;
  allowStart: boolean;
  started: boolean;
} | null = null;
let observation = 0;
let maintenance: { id: string; release: () => void } | null = null;
let poll: ReturnType<typeof setTimeout> | null = null;
function validateIntent(reply: WorktreeReply, id: string) {
  if (reply.kind !== "operation") return;
  const expected = intent?.id === id ? intent : null;
  const action =
    expected?.action ??
    (snapshot.operationId === id && snapshot.operation?.kind === "operation"
      ? snapshot.operation.action
      : null);
  if (action && reply.action !== action) throw new Error(S.unknown);
  const view = expected?.recycle;
  if (!view) return;
  if (
    (reply.originalPath && reply.originalPath !== view.originalPath) ||
    (reply.retainedPath && reply.retainedPath !== view.retainedPath)
  )
    throw new Error(S.unknown);
  const result = reply.archive ?? reply.location;
  if (
    result &&
    (result.id !== view.recordId ||
      result.repositoryRoot !== view.repositoryRoot ||
      result.headOid !== view.headOid ||
      result.branch !== view.branch ||
      result.ownership !== "created")
  )
    throw new Error(S.unknown);
}
function releaseMaintenance(id: string) {
  if (maintenance?.id !== id) return;
  const old = maintenance;
  maintenance = null;
  old.release();
  if (!maintenance) publish({ maintenanceLocked: false });
}
function holdMaintenance(id: string) {
  if (maintenance?.id === id) return;
  if (maintenance) throw new Error(S.pending);
  const owner = { id, release: () => {} };
  maintenance = owner;
  owner.release = draftPersistence.acquireInteractionLock();
  publish({ maintenanceLocked: true });
}
function pollMaintenance() {
  if (poll) clearTimeout(poll);
  poll = null;
  const op = snapshot.operation;
  if (
    op?.kind !== "operation" ||
    !op.maintenanceActive ||
    snapshot.uncertain ||
    !["running", "cancelling"].includes(op.state)
  )
    return;
  poll = setTimeout(() => {
    poll = null;
    if (snapshot.operationId !== op.operationId) return;
    if (snapshot.working) {
      pollMaintenance();
      return;
    }
    void queryOperation("worktree_status", op.operationId).then(
      pollMaintenance,
    );
  }, 750);
}
function publish(change: Partial<WorktreesSnapshot>) {
  snapshot = Object.freeze({ ...snapshot, ...change });
  for (const listener of listeners) listener();
}
function accept(reply: WorktreeReply, id: string, rechecked = false) {
  if (snapshot.operationId !== id) return;
  const old = snapshot.operation;
  // A later stale status must not turn confirmed completion back into work.
  if (
    old?.kind === "operation" &&
    old.settled &&
    (reply.kind !== "operation" ||
      !reply.settled ||
      (old.state !== "unknown" && reply.state === "unknown" && !rechecked))
  )
    return;
  if (
    old?.kind === "operation" &&
    old.reviewed &&
    reply.kind === "operation" &&
    reply.state === "unknown" &&
    !reply.reviewed
  )
    return;
  const location = reply.kind === "operation" ? reply.location : undefined;
  const savedLocation =
    location && snapshot.locations.find((item) => item.id === location.id);
  publish({
    operation: reply,
    uncertain: reply.kind === "unknownOperation" || reply.state === "unknown",
    ...(location &&
    (!savedLocation || savedLocation.revision <= location.revision)
      ? {
          locations: Object.freeze([
            ...snapshot.locations.filter((value) => value.id !== location.id),
            location,
          ]),
        }
      : {}),
    error: null,
  });
  if (snapshot.operationId !== id || snapshot.operation !== reply) return;
  if (reply.kind === "operation") {
    if (reply.maintenanceActive) holdMaintenance(id);
    else releaseMaintenance(id);
    if (
      reply.action === "archive" &&
      reply.state === "ready" &&
      reply.archive
    ) {
      const archive = reply.archive;
      publish({
        locations: Object.freeze(
          snapshot.locations.filter((l) => l.id !== archive.id),
        ),
        archives: Object.freeze([
          ...snapshot.archives.filter((a) => a.id !== archive.id),
          archive,
        ]),
      });
    }
    if (reply.action === "restore" && reply.state === "ready" && location)
      publish({
        archives: Object.freeze(
          snapshot.archives.filter((a) => a.id !== location.id),
        ),
      });
  }
  pollMaintenance();
}
async function observe(
  command: string,
  id: string,
): Promise<WorktreeReply | null> {
  // Retire a late prepared intent by its own ID without touching a newer UI operation.
  if (snapshot.operationId !== id) {
    try {
      return parseWorktreeReply(await invoke(command, { operationId: id }), id);
    } catch {
      return null;
    }
  }
  const request = ++observation;
  publish({ working: true, error: null });
  const unconfirmed = () => {
    if (snapshot.operationId !== id || request !== observation) return;
    const old = snapshot.operation;
    publish({
      working: false,
      ...(old?.kind === "operation" && old.settled
        ? { error: S.checkFailed }
        : { uncertain: true, error: S.unknown }),
    });
  };
  const timer = setTimeout(() => {
    if (snapshot.operationId !== id || request !== observation) return;
    if (intent?.id === id) intent.allowStart = false;
    unconfirmed();
  }, 10_000);
  try {
    const reply = parseWorktreeReply(
      await invoke(command, { operationId: id }),
      id,
    );
    validateIntent(reply, id);
    if (request === observation)
      accept(reply, id, command === "worktree_recheck");
    return reply;
  } catch {
    unconfirmed();
    return null;
  } finally {
    clearTimeout(timer);
    if (snapshot.operationId === id && request === observation)
      publish({ working: false });
  }
}
async function reload() {
  if (snapshot.working) return;
  const before = snapshot.operationId;
  publish({ loading: true, error: null });
  try {
    const result = parseWorktreeList(await invoke("worktree_list"));
    if (before !== snapshot.operationId || snapshot.working) return;
    publish({
      locations: result.locations,
      materials: result.materials,
      archives: result.archives,
      ready: true,
    });
    if (!snapshot.operationId && result.operation) {
      publish({ operationId: result.operation.operationId });
      accept(result.operation, result.operation.operationId);
    } else if (result.operation?.operationId === snapshot.operationId)
      accept(result.operation, result.operation.operationId);
  } catch {
    publish({ error: S.loadFailed });
  } finally {
    publish({ loading: false });
  }
}
async function queryOperation(command: string, id: string) {
  const reply = await observe(command, id);
  if (
    reply?.kind === "operation" &&
    reply.reviewed &&
    snapshot.operationId === id &&
    snapshot.operation?.kind === "operation" &&
    snapshot.operation.reviewed
  ) {
    // A lost acknowledgement may first be recovered by status. Read the preserved
    // material list before allowing another intent to replace this visible result.
    publish({ ready: false });
    await worktrees.load();
  }
  return reply;
}
async function begin(
  command:
    "worktree_prepare_create" | "worktree_adopt" | "worktree_recycle_prepare",
  input: object,
  current: () => boolean,
  recycle?: WorktreeRecycleInspection,
) {
  if (!current()) throw new Error(S.changed);
  const op = snapshot.operation;
  if (
    snapshot.working ||
    maintenance !== null ||
    snapshot.loading ||
    !snapshot.ready ||
    (snapshot.operationId &&
      (!op ||
        op.kind === "unknownOperation" ||
        !op.settled ||
        (op.state === "unknown" && !op.reviewed)))
  )
    throw new Error(S.pending);
  const action =
    command === "worktree_adopt"
      ? "adopt"
      : command === "worktree_prepare_create"
        ? "create"
        : "action" in input &&
            (input.action === "archive" || input.action === "restore")
          ? input.action
          : null;
  if (!action) throw new Error(S.unavailable);
  const local: NonNullable<typeof intent> = {
    id: crypto.randomUUID(),
    action,
    ...(recycle ? { recycle } : {}),
    allowStart: true,
    started: false,
  };
  intent = local;
  const request = ++observation;
  const recycling = command === "worktree_recycle_prepare";
  if (recycling) holdMaintenance(local.id);
  let dispatched = false;
  publish({
    operationId: local.id,
    operation: null,
    working: true,
    uncertain: false,
    error: null,
  });
  const timer = setTimeout(() => {
    local.allowStart = false;
    if (intent === local && observation === request)
      publish({ working: false, uncertain: true, error: S.unknown });
  }, 10_000);
  try {
    if (recycling) {
      threads.pauseQueuesForExit();
      await Promise.all([draftPersistence.flush(), setupStorage.flush()]);
      if (!current() || intent !== local || !local.allowStart)
        throw new Error(S.changed);
    }
    dispatched = true;
    const reply = parseWorktreeReply(
      await invoke(command, { ...input, operationId: local.id }),
      local.id,
    );
    if (reply.kind === "operation" && reply.action !== local.action)
      throw new Error(S.unknown);
    validateIntent(reply, local.id);
    if (
      command !== "worktree_adopt" &&
      reply.kind === "operation" &&
      reply.settled &&
      (reply.state === "failed" || reply.state === "cancelled")
    ) {
      local.allowStart = false;
      accept(reply, local.id);
      return;
    }
    if (
      command !== "worktree_adopt" &&
      (reply.kind !== "operation" || reply.state !== "prepared")
    ) {
      // Preparing must never publish a fabricated successful checkout.
      local.allowStart = false;
      if (intent === local) publish({ uncertain: true, error: S.unknown });
      return;
    }
    accept(reply, local.id);
    if (command === "worktree_adopt") return;
    // A newer status may already have confirmed cancellation while prepare waited.
    if (snapshot.operationId === local.id && snapshot.operation !== reply) {
      local.allowStart = false;
      return;
    }
    if (intent !== local || !local.allowStart || !current()) {
      local.allowStart = false;
      await observe("worktree_cancel", local.id);
      return;
    }
    local.started = true;
    // Clear prepare's timer before observing start; no automatic replay.
    clearTimeout(timer);
    await observe("worktree_start", local.id);
  } catch (reason) {
    local.allowStart = false;
    if (recycling && !dispatched) {
      releaseMaintenance(local.id);
      if (intent === local)
        publish({
          operationId: null,
          operation: null,
          uncertain: false,
          error: worktreeFailureMessage(reason),
        });
    } else if (intent === local) publish({ uncertain: true, error: S.unknown });
  } finally {
    clearTimeout(timer);
    if (intent === local && observation === request)
      publish({ working: false });
  }
}
export const worktrees = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  load: () =>
    (loading ??= reload().finally(() => {
      loading = null;
    })),
  inspect: async (path: string) => {
    try {
      return parseWorktreeInspection(
        await invoke("worktree_inspect", { path }),
      );
    } catch (reason) {
      throw new Error(worktreeFailureMessage(reason));
    }
  },
  refs: async (inspectionId: string, cursor?: string) => {
    try {
      return parseWorktreeRefs(
        await invoke("worktree_refs", {
          inspectionId,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
    } catch (reason) {
      throw new Error(worktreeFailureMessage(reason));
    }
  },
  create: (input: WorktreeCreate, current: () => boolean) =>
    begin("worktree_prepare_create", structuredClone(input), current),
  adopt: (inspectionId: string, treePath: string, current: () => boolean) =>
    begin("worktree_adopt", { inspectionId, treePath }, current),
  async inspectRecycle(
    action: WorktreeRecycleAction,
    record: WorktreeLocation | WorktreeArchive,
  ) {
    const source =
      action === "archive" ? snapshot.locations : snapshot.archives;
    if (
      record.ownership !== "created" ||
      (action === "restore" && record.availability !== "verified") ||
      !source.some((item) => item === record)
    )
      throw new Error(S.changed);
    try {
      const result = parseWorktreeRecycleInspection(
        await invoke("worktree_recycle_inspect", {
          action,
          recordId: record.id,
          expectedRevision: record.revision,
        }),
      );
      if (
        result.action !== action ||
        result.recordId !== record.id ||
        result.revision !== record.revision ||
        result.repositoryRoot !== record.repositoryRoot ||
        result.originalPath !==
          ("path" in record ? record.path : record.originalPath) ||
        ("retainedPath" in record &&
          result.retainedPath !== record.retainedPath)
      )
        throw new Error(S.changed);
      return result;
    } catch (reason) {
      throw new Error(worktreeFailureMessage(reason));
    }
  },
  recycle: (inspection: WorktreeRecycleInspection, current: () => boolean) => {
    if (
      inspection.blockers.length ||
      inspection.impact.unsent ||
      draftPersistence.snapshot().interactionLocked
    )
      throw new Error(S.recycleBlocked);
    return begin(
      "worktree_recycle_prepare",
      {
        inspectionId: inspection.inspectionId,
        action: inspection.action,
        expectedDraftBaseline: inspection.draftBaseline,
      },
      current,
      inspection,
    );
  },
  status: async () =>
    snapshot.operationId
      ? queryOperation("worktree_status", snapshot.operationId)
      : null,
  recheck: async () =>
    snapshot.operationId
      ? queryOperation("worktree_recheck", snapshot.operationId)
      : null,
  cancel: async (expectedId = snapshot.operationId) => {
    if (expectedId !== snapshot.operationId) return null;
    if (intent) intent.allowStart = false;
    return snapshot.operationId
      ? observe("worktree_cancel", snapshot.operationId)
      : null;
  },
  acknowledge: async (expectedId: string) => {
    const op = snapshot.operation;
    if (
      snapshot.working ||
      !op ||
      expectedId !== snapshot.operationId ||
      op.kind !== "operation" ||
      op.state !== "unknown" ||
      !op.settled ||
      op.maintenanceActive ||
      op.reviewed
    )
      throw new Error(S.pending);
    await queryOperation("worktree_acknowledge", op.operationId);
  },
  async checkArchive(archive: WorktreeArchive) {
    if (snapshot.working || snapshot.loading) throw new Error(S.pending);
    if (!snapshot.archives.includes(archive)) throw new Error(S.changed);
    const request = ++observation;
    const operationId = snapshot.operationId;
    publish({ working: true, error: null });
    try {
      const result = parseWorktreeList(
        await invoke("worktree_recycle_check", {
          recordId: archive.id,
          expectedRevision: archive.revision,
        }),
      );
      if (
        request !== observation ||
        operationId !== snapshot.operationId ||
        !snapshot.archives.includes(archive)
      )
        return;
      const found =
        result.archives.find((a) => a.id === archive.id) ??
        result.locations.find((l) => l.id === archive.id);
      if (
        !found ||
        found.ownership !== "created" ||
        found.revision < archive.revision ||
        found.repositoryRoot !== archive.repositoryRoot ||
        ("path" in found
          ? found.path !== archive.originalPath
          : found.originalPath !== archive.originalPath ||
            found.retainedPath !== archive.retainedPath)
      )
        throw new Error(S.changed);
      publish({
        locations: result.locations,
        archives: result.archives,
        materials: result.materials,
        ready: true,
      });
      if (result.operation?.operationId === snapshot.operationId)
        accept(result.operation, result.operation.operationId, true);
    } catch (reason) {
      if (request === observation && operationId === snapshot.operationId)
        publish({ error: worktreeFailureMessage(reason) });
      throw new Error(worktreeFailureMessage(reason));
    } finally {
      if (request === observation && operationId === snapshot.operationId)
        publish({ working: false });
    }
  },
  async check(location: WorktreeLocation): Promise<WorktreeLocation> {
    if (snapshot.archives.some((a) => a.id === location.id))
      throw new Error(S.archivedNote);
    try {
      const result = parseWorktreeLocation(
        await invoke("worktree_check_location", { locationId: location.id }),
      );
      if (
        result.id !== location.id ||
        result.path !== location.path ||
        result.repositoryRoot !== location.repositoryRoot ||
        result.ownership !== location.ownership
      )
        throw new Error();
      publish({
        locations: Object.freeze(
          snapshot.locations.map((item) =>
            item.id === result.id ? result : item,
          ),
        ),
      });
      if (result.availability !== "verified") throw new Error();
      return result;
    } catch (reason) {
      // The backend may persist missing/changed before rejecting the check.
      // Reading that state cannot apply a location or create another operation.
      await worktrees.load();
      throw new Error(worktreeFailureMessage(reason));
    }
  },
  async forget(location: WorktreeLocation) {
    if (snapshot.archives.some((a) => a.id === location.id))
      throw new Error(S.archivedNote);
    if (snapshot.working) throw new Error(S.pending);
    publish({ working: true, error: null });
    try {
      const result = await invoke<unknown>("worktree_forget", {
        locationId: location.id,
        expectedRevision: location.revision,
      });
      if (
        !result ||
        typeof result !== "object" ||
        Object.keys(result).length !== 1 ||
        !("forgotten" in result) ||
        result.forgotten !== true
      )
        throw new Error();
      publish({
        locations: Object.freeze(
          snapshot.locations.filter((item) => item.id !== location.id),
        ),
        ...(snapshot.operation?.kind === "operation" &&
        snapshot.operation.location?.id === location.id
          ? { operation: null, operationId: null, uncertain: false }
          : {}),
      });
    } catch {
      publish({ error: S.forgetFailed });
      throw new Error(S.forgetFailed);
    } finally {
      publish({ working: false });
    }
  },
};
export function useWorktrees() {
  const state = useSyncExternalStore(
    worktrees.subscribe,
    worktrees.snapshot,
    worktrees.snapshot,
  );
  useEffect(() => {
    void worktrees.load();
  }, []);
  // Only observe the one known operation; polling never creates or replays it.
  useEffect(() => {
    const op = state.operation;
    if (
      !op ||
      op.kind !== "operation" ||
      op.settled ||
      state.uncertain ||
      state.working
    )
      return;
    const timer = setTimeout(() => {
      void worktrees.status();
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.operation, state.uncertain, state.working]);
  return state;
}
