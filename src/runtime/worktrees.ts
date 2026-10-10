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
  parseWorktreeRemoveInspection,
  type WorktreeRemoveInspection,
  type WorktreeRecovery,
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
  recoveries: readonly WorktreeRecovery[];
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
  recoveries: [],
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
let catalogueObservation = 0;
let catalogueRead: {
  promise: Promise<ReturnType<typeof parseWorktreeList>>;
  operationId: string | null;
  observation: number;
} | null = null;
let intent: {
  id: string;
  action: "create" | "adopt" | "archive" | "restore" | "remove" | "recover";
  recovery?: { receipt: WorktreeRecovery; targetPath: string };
  recycle?: WorktreeRecycleInspection;
  allowStart: boolean;
  started: boolean;
} | null = null;
type RemovalIntent = {
  id: string;
  owner: object;
  view: WorktreeRemoveInspection;
  current: () => boolean;
  allowed: boolean;
  confirming: boolean;
  dispatched: boolean;
};
let removal: RemovalIntent | null = null;
const removalInspections = new WeakSet<WorktreeRemoveInspection>();
function retireRemoval(id: string) {
  if (removal?.id === id) {
    removal.allowed = false;
    removal.confirming = false;
  }
}
const recoveryProofKeys = [
  "id",
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
] as const;
function sameRecoveryProof(a: WorktreeRecovery, b: WorktreeRecovery) {
  return recoveryProofKeys.every((key) => a[key] === b[key]);
}
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
  if (reply.action === "recover" && expected?.recovery) {
    const source = expected.recovery;
    if (
      (reply.targetPath && reply.targetPath !== source.targetPath) ||
      (reply.recovery &&
        (!sameRecoveryProof(reply.recovery, source.receipt) ||
          reply.recovery.revision !== source.receipt.revision))
    )
      throw new Error(S.unknown);
  }
  if (reply.action === "remove") {
    const view = removal?.id === id ? removal.view : null;
    const r = reply.recovery;
    if (
      view &&
      ((reply.originalPath && reply.originalPath !== view.originalPath) ||
        (reply.retainedPath && reply.retainedPath !== view.retainedPath) ||
        (r &&
          (r.archiveId !== view.recordId ||
            r.archiveRevision !== view.revision ||
            r.originalPath !== view.originalPath ||
            r.retainedPath !== view.retainedPath ||
            r.repositoryRoot !== view.repositoryRoot ||
            r.headOid !== view.headOid ||
            r.branch !== view.branch ||
            r.rootsSha256 !== view.roots.sha256 ||
            r.contentSha256 !== view.content.sha256 ||
            r.rootCount !== view.roots.count ||
            r.objectFormat !== view.roots.objectFormat)))
    )
      throw new Error(S.unknown);
  }
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
    if (snapshot.working || snapshot.loading) {
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
    if (reply.action === "remove") {
      if (reply.state === "ready" && reply.removed)
        publish({
          archives: Object.freeze(
            snapshot.archives.filter((a) => a.id !== reply.removed?.recordId),
          ),
        });
      if (reply.settled || reply.deleteDispatched || reply.cancelRequested)
        retireRemoval(id);
    }
    if (snapshot.operationId !== id || snapshot.operation !== reply) return;
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
  parameters: object = {},
  dispatchCurrent?: () => boolean,
): Promise<WorktreeReply | null> {
  // Retire a late prepared intent by its own ID without touching a newer UI operation.
  if (snapshot.operationId !== id) {
    if (dispatchCurrent) return null;
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
    retireRemoval(id);
    unconfirmed();
  }, 10_000);
  try {
    if (dispatchCurrent && !dispatchCurrent()) return null;
    const reply = parseWorktreeReply(
      await invoke(command, { ...parameters, operationId: id }),
      id,
    );
    validateIntent(reply, id);
    if (request === observation)
      accept(reply, id, command === "worktree_recheck");
    return reply;
  } catch {
    if (snapshot.operationId === id && request === observation)
      retireRemoval(id);
    unconfirmed();
    return null;
  } finally {
    clearTimeout(timer);
    if (snapshot.operationId === id && request === observation) {
      publish({ working: false });
      await refreshRemovalCatalogue(id, request);
    }
  }
}
async function refreshRemovalCatalogue(id: string, request: number) {
  const op = snapshot.operation;
  if (
    snapshot.operationId === id &&
    observation === request &&
    op?.kind === "operation" &&
    op.action === "remove" &&
    op.recovery
  )
    await reload(true);
}
async function reload(recoveriesOnly = false) {
  if (snapshot.working) return;
  const before = snapshot.operationId,
    request = observation;
  const ticket = ++catalogueObservation;
  const owns = () =>
    before === snapshot.operationId &&
    request === observation &&
    ticket === catalogueObservation;
  publish({ loading: true, error: null });
  // Keep the actual read single-flight even after an observer stops waiting.
  // A timeout is not proof that the native mutex/SQLite read has ended.
  if (!catalogueRead) {
    const read = {
      operationId: before,
      observation: request,
      promise: Promise.resolve()
        .then(() => invoke("worktree_list"))
        .then(parseWorktreeList),
    };
    catalogueRead = read;
    const release = () => {
      if (catalogueRead === read) catalogueRead = null;
    };
    void read.promise.then(release, release);
  }
  const read = catalogueRead;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      read.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(S.loadFailed)), 10_000);
      }),
    ]);
    if (!owns() || snapshot.working) return;
    if (read.operationId !== before || read.observation !== request) {
      // The joined read predates the current operation. Keep old proof and
      // require a fresh explicit catalogue read, never promote its late result.
      publish({ error: S.loadFailed });
      return;
    }
    if (recoveriesOnly) {
      // A status receipt cannot promote persisted backups. Refresh that catalogue
      // without replacing the archive object owning a separate deletion decision.
      publish({ recoveries: result.recoveries });
    } else {
      publish({
        locations: result.locations,
        materials: result.materials,
        archives: result.archives,
        recoveries: result.recoveries,
        ready: true,
      });
      if (!snapshot.operationId && result.operation) {
        publish({ operationId: result.operation.operationId });
        accept(result.operation, result.operation.operationId);
      } else if (result.operation?.operationId === snapshot.operationId)
        accept(result.operation, result.operation.operationId);
    }
  } catch {
    if (owns()) publish({ error: S.loadFailed });
  } finally {
    clearTimeout(timer);
    if (ticket === catalogueObservation) publish({ loading: false });
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
    | "worktree_prepare_create"
    | "worktree_adopt"
    | "worktree_recycle_prepare"
    | "worktree_recover_prepare",
  input: object,
  current: () => boolean,
  recycle?: WorktreeRecycleInspection,
  recovery?: { receipt: WorktreeRecovery; targetPath: string },
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
      : command === "worktree_recover_prepare"
        ? "recover"
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
    ...(recovery ? { recovery } : {}),
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
    let startDispatched = false;
    await observe("worktree_start", local.id, {}, () => {
      if (!current()) return false;
      startDispatched =
        intent === local &&
        local.allowStart &&
        snapshot.operationId === local.id &&
        snapshot.operation === reply;
      return startDispatched;
    });
    if (!startDispatched) {
      local.allowStart = false;
      await observe("worktree_cancel", local.id);
    }
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
function canConfirmRemoval(owner: object, op: WorktreeReply): boolean {
  const local = removal;
  if (
    !local ||
    local.owner !== owner ||
    !local.allowed ||
    local.confirming ||
    !local.current()
  )
    return false;
  return (
    removal === local &&
    local.allowed &&
    !local.confirming &&
    snapshot.operation === op &&
    snapshot.operationId === local.id &&
    !snapshot.working &&
    !snapshot.uncertain &&
    op.kind === "operation" &&
    op.action === "remove" &&
    op.state === "prepared" &&
    op.removalPhase === "awaitingConfirmation" &&
    !op.deleteDispatched &&
    !op.cancelRequested &&
    op.maintenanceActive &&
    maintenance?.id === local.id &&
    op.recovery?.availability === "verified"
  );
}
async function prepareRemoval(
  view: WorktreeRemoveInspection,
  owner: object,
  current: () => boolean,
) {
  if (!current() || !removalInspections.has(view)) throw new Error(S.changed);
  const op = snapshot.operation;
  if (
    view.blockers.length ||
    view.impact.unsent ||
    draftPersistence.snapshot().interactionLocked ||
    snapshot.working ||
    snapshot.loading ||
    maintenance ||
    !snapshot.ready ||
    (snapshot.operationId &&
      (!op ||
        op.kind !== "operation" ||
        !op.settled ||
        (op.state === "unknown" && !op.reviewed)))
  )
    throw new Error(S.recycleBlocked);
  const local: RemovalIntent = {
    id: crypto.randomUUID(),
    owner,
    view,
    current,
    allowed: true,
    confirming: false,
    dispatched: false,
  };
  removal = local;
  intent = {
    id: local.id,
    action: "remove",
    allowStart: false,
    started: false,
  };
  const request = ++observation;
  holdMaintenance(local.id);
  publish({
    operationId: local.id,
    operation: null,
    working: true,
    uncertain: false,
    error: null,
  });
  const timer = setTimeout(() => {
    local.allowed = false;
    if (removal === local && observation === request)
      publish({ working: false, uncertain: true, error: S.unknown });
  }, 10_000);
  try {
    if (!local.allowed || !current() || removal !== local)
      throw new Error(S.changed);
    threads.pauseQueuesForExit();
    await Promise.all([draftPersistence.flush(), setupStorage.flush()]);
    if (!current() || removal !== local || !local.allowed)
      throw new Error(S.changed);
    local.dispatched = true;
    const reply = parseWorktreeReply(
      await invoke("worktree_remove_prepare", {
        operationId: local.id,
        inspectionId: view.inspectionId,
        expectedDraftBaseline: view.draftBaseline,
      }),
      local.id,
    );
    validateIntent(reply, local.id);
    if (
      reply.kind !== "operation" ||
      reply.action !== "remove" ||
      (reply.state !== "prepared" &&
        reply.state !== "running" &&
        reply.state !== "failed" &&
        reply.state !== "cancelled" &&
        reply.state !== "unknown") ||
      reply.deleteDispatched
    )
      throw new Error(S.unknown);
    // A newer cancel/status remains authoritative. A preparation reply never dispatches deletion.
    if (snapshot.operationId === local.id && observation === request)
      accept(reply, local.id);
    if (!current() || removal !== local || !local.allowed) {
      local.allowed = false;
      if (!reply.settled) await observe("worktree_cancel", local.id);
    }
  } catch (reason) {
    local.allowed = false;
    if (!local.dispatched) {
      releaseMaintenance(local.id);
      if (removal === local)
        publish({
          operationId: null,
          operation: null,
          uncertain: false,
          error: worktreeFailureMessage(reason),
        });
    } else if (removal === local && observation === request)
      publish({ uncertain: true, error: S.unknown });
  } finally {
    clearTimeout(timer);
    if (removal === local && observation === request) {
      publish({ working: false });
      await refreshRemovalCatalogue(local.id, request);
    }
    pollMaintenance();
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
  load: () => reload(),
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
      throw new Error(worktreeFailureMessage(reason, action));
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
  async inspectRemoval(record: WorktreeArchive) {
    if (
      record.ownership !== "created" ||
      record.availability !== "verified" ||
      !snapshot.archives.includes(record)
    )
      throw new Error(S.changed);
    try {
      const view = parseWorktreeRemoveInspection(
        await invoke("worktree_remove_inspect", {
          recordId: record.id,
          expectedRevision: record.revision,
        }),
      );
      if (
        !snapshot.archives.includes(record) ||
        view.recordId !== record.id ||
        view.revision !== record.revision ||
        view.originalPath !== record.originalPath ||
        view.retainedPath !== record.retainedPath ||
        view.repositoryRoot !== record.repositoryRoot ||
        view.headOid !== record.headOid ||
        view.branch !== record.branch
      )
        throw new Error(S.changed);
      removalInspections.add(view);
      return view;
    } catch (reason) {
      throw new Error(worktreeFailureMessage(reason));
    }
  },
  prepareRemoval,
  canConfirmRemoval,
  withdrawRemoval(owner: object) {
    const local = removal;
    if (!local || local.owner !== owner) return;
    local.allowed = false;
    local.confirming = false;
    if (
      local.dispatched &&
      snapshot.operationId === local.id &&
      !(
        snapshot.operation?.kind === "operation" &&
        snapshot.operation.settled &&
        !snapshot.operation.maintenanceActive
      )
    )
      void observe("worktree_cancel", local.id);
  },
  async confirmRemoval(owner: object, op: WorktreeReply) {
    if (
      !canConfirmRemoval(owner, op) ||
      op.kind !== "operation" ||
      op.action !== "remove" ||
      !op.recovery
    )
      throw new Error(S.changed);
    const local = removal!;
    const r = op.recovery;
    local.allowed = false;
    local.confirming = true;
    const parameters = {
      recordId: local.view.recordId,
      expectedRevision: local.view.revision,
      recoveryId: r.id,
      recoverySha256: r.bundleSha256,
      manifestSha256: r.manifestSha256,
    };
    await observe("worktree_remove_confirm", local.id, parameters, () => {
      if (!local.confirming || removal !== local || !local.current())
        return false;
      return (
        local.confirming &&
        removal === local &&
        snapshot.operation === op &&
        snapshot.operationId === local.id &&
        maintenance?.id === local.id
      );
    });
  },
  recover(
    recovery: WorktreeRecovery,
    parentPath: string,
    directoryName: string,
    current: () => boolean,
  ) {
    if (
      !snapshot.recoveries.includes(recovery) ||
      recovery.availability !== "verified" ||
      draftPersistence.snapshot().interactionLocked ||
      !parentPath ||
      !directoryName.trim() ||
      /[\\/\0]/.test(directoryName) ||
      [".", ".."].includes(directoryName)
    )
      throw new Error(S.changed);
    const targetPath = parentPath.endsWith("/")
      ? parentPath + directoryName
      : parentPath + "/" + directoryName;
    return begin(
      "worktree_recover_prepare",
      {
        recoveryId: recovery.id,
        expectedRevision: recovery.revision,
        parentPath,
        directoryName,
      },
      current,
      undefined,
      { receipt: recovery, targetPath },
    );
  },
  async checkRecovery(recovery: WorktreeRecovery) {
    if (
      snapshot.working ||
      snapshot.loading ||
      !snapshot.recoveries.includes(recovery)
    )
      throw new Error(S.pending);
    const request = ++observation,
      id = snapshot.operationId;
    publish({ working: true, error: null });
    try {
      const result = parseWorktreeList(
        await invoke("worktree_recovery_check", {
          recoveryId: recovery.id,
          expectedRevision: recovery.revision,
        }),
      );
      if (request !== observation || id !== snapshot.operationId) return;
      const next = result.recoveries.find((r) => r.id === recovery.id);
      if (
        !next ||
        next.revision < recovery.revision ||
        !sameRecoveryProof(next, recovery)
      )
        throw new Error(S.changed);
      publish({
        recoveries: result.recoveries,
        archives: result.archives,
        locations: result.locations,
        materials: result.materials,
      });
      if (result.operation?.operationId === id)
        accept(result.operation, id, true);
    } catch (reason) {
      if (request === observation)
        publish({ error: worktreeFailureMessage(reason) });
    } finally {
      if (request === observation && id === snapshot.operationId)
        publish({ working: false });
    }
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
    if (expectedId) retireRemoval(expectedId);
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
        recoveries: result.recoveries,
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
      (op.action === "remove" && op.state === "prepared") ||
      state.uncertain ||
      state.working ||
      state.loading
    )
      return;
    const timer = setTimeout(() => {
      const current = worktrees.snapshot();
      if (
        current.operation === op &&
        !current.uncertain &&
        !current.working &&
        !current.loading
      )
        void worktrees.status();
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.operation, state.uncertain, state.working, state.loading]);
  return state;
}
