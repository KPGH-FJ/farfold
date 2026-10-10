import { useEffect, useRef, useState, type RefObject } from "react";
import { chooseDirectory } from "../runtime/dialogs";
import { worktrees, useWorktrees } from "../runtime/worktrees";
import type {
  WorktreeInspection,
  WorktreeLocation,
} from "../runtime/worktree_types";
import {
  WORKTREE_STRINGS as S,
  worktreeErrorMessage,
  worktreeFailureMessage,
} from "../runtime/worktree_strings";
import { WorktreeRemovalReview } from "./WorktreeRemovalReview";
import { WorktreeRecoveries } from "./WorktreeRecoveries";
import { WorktreeRecoveryForm } from "./WorktreeRecoveryForm";
import type {
  WorktreeArchive,
  WorktreeRecovery,
} from "../runtime/worktree_types";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorktreeCreateForm } from "./WorktreeCreateForm";
import {
  WorktreeRecycleReview,
  type WorktreeRecycleSelection,
} from "./WorktreeRecycleReview";
import { useDraftSaveStatus, draftPersistence } from "../runtime/draft_storage";
import "./WorktreeDialog.css";
import type { WorkLocationIntent } from "../runtime/worktree_management";
export type { WorkLocationIntent } from "../runtime/worktree_management";

export function WorktreeDialog({
  cwd,
  target,
  onClose,
  returnFocusRef,
}: {
  cwd: string | null;
  target: WorkLocationIntent | null;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const state = useWorktrees();
  const draftStatus = useDraftSaveStatus();
  const [recycle, setRecycle] = useState<WorktreeRecycleSelection | null>(null);
  const [removal, setRemoval] = useState<WorktreeArchive | null>(null);
  const [recovering, setRecovering] = useState<WorktreeRecovery | null>(null);
  const currentRecovering = useRef(recovering);
  currentRecovering.current = recovering;
  const currentRemoval = useRef(removal);
  currentRemoval.current = removal;
  const currentRecycle = useRef(recycle);
  currentRecycle.current = recycle;
  const [inspection, setInspection] = useState<WorktreeInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<WorktreeLocation | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const mounted = useRef(true);
  const working = useRef(false);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () =>
    mounted.current &&
    target !== null &&
    currentTarget.current === target &&
    target.isCurrent();
  const operation = state.operation;
  const maintenanceAction =
    operation?.kind === "operation" &&
    (operation.action === "archive" ||
      operation.action === "restore" ||
      operation.action === "remove");
  const operationLabel =
    operation?.kind !== "operation"
      ? S.unknownId
      : operation.action === "recover"
        ? S.recovery[
            operation.state === "prepared" ? "preparing" : operation.state
          ]
        : operation.action === "remove"
          ? operation.state === "ready"
            ? S.removal.ready
            : operation.state === "failed"
              ? S.removal.failed
              : operation.state === "cancelled"
                ? S.removal.cancelled
                : operation.state === "unknown"
                  ? S.removal.unknown
                  : S.removal.phases[operation.removalPhase]
          : !maintenanceAction
            ? S.states[operation.state]
            : operation.state === "ready"
              ? operation.action === "archive"
                ? S.archiveReady
                : S.restoreReady
              : operation.state === "failed"
                ? S.recycleFailed
                : operation.state === "cancelled"
                  ? S.recycleCancelled
                  : operation.state === "unknown"
                    ? S.states.unknown
                    : operation.state === "cancelling"
                      ? S.states.cancelling
                      : S.recycleRunning;
  const operationNote =
    operation?.kind === "operation" && operation.action === "remove"
      ? state.uncertain
        ? S.removal.unknown
        : S.removal.resultNote
      : operation?.kind === "operation" && operation.action === "recover"
        ? state.uncertain
          ? S.recovery.unknown
          : S.recovery.note
        : maintenanceAction
          ? state.uncertain
            ? S.recycleUnknown
            : S.recycleResultNote
          : state.uncertain
            ? S.unknown
            : S.delayed;
  const canBegin =
    state.ready &&
    !state.loading &&
    !state.working &&
    !draftStatus.interactionLocked &&
    (!state.uncertain ||
      (operation?.kind === "operation" && operation.reviewed)) &&
    (!state.operationId ||
      (operation?.kind === "operation" &&
        operation.settled &&
        (operation.state !== "unknown" || operation.reviewed)));
  const act = async (action: () => Promise<void>) => {
    if (!mounted.current || working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (mounted.current) setError(worktreeFailureMessage(reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const use = async (location: WorktreeLocation) => {
    if (!current() || !target) throw new Error(S.changed);
    const checked = await worktrees.check(location);
    if (!current()) throw new Error(S.changed);
    if (!(await target.apply(checked.path))) throw new Error(S.changed);
    if (mounted.current && currentTarget.current === target) onClose();
  };
  const locations = state.locations;
  const canManage = () => {
    const now = worktrees.snapshot(),
      op = now.operation;
    return (
      mounted.current &&
      !working.current &&
      !draftPersistence.snapshot().interactionLocked &&
      now.ready &&
      !now.loading &&
      !now.working &&
      (!now.operationId ||
        (op?.kind === "operation" &&
          op.settled &&
          (op.state !== "unknown" || op.reviewed)))
    );
  };
  return (
    <WorkspaceDialog
      title={S.title}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="worktree-dialog-body">
        <p>{S.note}</p>
        {target && !state.maintenanceLocked && !current() && (
          <p role="status">{S.changed}</p>
        )}
        <div className="worktree-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !current()}
            onClick={() =>
              void act(async () => {
                const path = await chooseDirectory(cwd ?? undefined);
                if (!path) return;
                if (!current() || !target || !(await target.apply(path)))
                  throw new Error(S.changed);
                if (mounted.current && currentTarget.current === target)
                  onClose();
              })
            }
          >
            {S.ordinary}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !canBegin || !current()}
            onClick={() =>
              void act(async () => {
                const path = await chooseDirectory(cwd ?? undefined);
                if (!path || !current()) return;
                const result = await worktrees.inspect(path);
                if (current()) setInspection(result);
              })
            }
          >
            {S.inspect}
          </button>
        </div>
        {(error || state.error) && <p role="alert">{error ?? state.error}</p>}
        {state.operationId && (
          <section className="worktree-operation" aria-live="polite">
            <strong>
              {operation?.kind === "operation"
                ? operationLabel
                : state.working
                  ? state.maintenanceLocked
                    ? S.recyclePreparing
                    : S.states.preparing
                  : S.unknownId}
            </strong>
            {operationNote !== operationLabel && <p>{operationNote}</p>}
            {state.maintenanceLocked && (
              <p role="status">{S.maintenanceHeld}</p>
            )}
            {operation?.kind === "operation" && operation.code && (
              <p>
                {operation.code === "cancelled" &&
                (operation.state !== "cancelled" ||
                  maintenanceAction ||
                  operation.action === "recover")
                  ? S.cancelRequested
                  : worktreeErrorMessage(operation.code, operation.action)}
              </p>
            )}
            {operation?.kind === "operation" && operation.targetPath && (
              <p className="worktree-path">{operation.targetPath}</p>
            )}
            {operation?.kind === "operation" &&
              operation.originalPath &&
              operation.retainedPath && (
                <dl className="worktree-paths">
                  <dt>{S.recycleOriginal}</dt>
                  <dd>{operation.originalPath}</dd>
                  <dt>{S.recycleRetained}</dt>
                  <dd>{operation.retainedPath}</dd>
                </dl>
              )}
            {operation?.kind === "operation" &&
              operation.state === "unknown" &&
              operation.settled &&
              !operation.maintenanceActive &&
              (operation.reviewed ? (
                <p>
                  {operation.action === "remove"
                    ? S.removal.reviewed
                    : S.reviewed}
                </p>
              ) : (
                <div>
                  {reviewing === operation.operationId ? (
                    <>
                      <p>
                        {operation.action === "remove"
                          ? S.removal.reviewNote
                          : maintenanceAction
                            ? S.recycleReviewNote
                            : S.reviewNote}
                      </p>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={busy || state.working}
                        onClick={() =>
                          void act(async () => {
                            await worktrees.acknowledge(operation.operationId);
                          })
                        }
                      >
                        {S.confirmReview}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || state.working}
                      onClick={() => setReviewing(operation.operationId)}
                    >
                      {S.review}
                    </button>
                  )}
                </div>
              ))}
            <div className="worktree-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || state.working}
                onClick={() =>
                  void act(async () => {
                    await worktrees.recheck();
                  })
                }
              >
                {S.check}
              </button>
              {(!operation ||
                operation.kind === "unknownOperation" ||
                operation.maintenanceActive ||
                !operation.settled) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    void worktrees.cancel(state.operationId);
                  }}
                >
                  {operation?.kind === "operation" &&
                  operation.action === "remove"
                    ? S.removal.cancel
                    : maintenanceAction
                      ? S.recycleCancelRequest
                      : S.cancel}
                </button>
              )}
            </div>
          </section>
        )}
        <div className="worktree-actions">
          <h3>{S.manage}</h3>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || state.loading || state.working}
            onClick={() => void worktrees.load()}
          >
            {S.refresh}
          </button>
        </div>
        {recovering && (
          <WorktreeRecoveryForm
            key={recovering.id + ":" + recovering.revision}
            recovery={recovering}
            current={() =>
              mounted.current &&
              currentRecovering.current === recovering &&
              !draftPersistence.snapshot().interactionLocked &&
              worktrees.snapshot().recoveries.includes(recovering)
            }
            onClose={() =>
              setRecovering((old) => (old === recovering ? null : old))
            }
          />
        )}
        {removal && (
          <WorktreeRemovalReview
            key={`remove:${removal.id}:${removal.revision}`}
            archive={removal}
            current={() =>
              mounted.current &&
              currentRemoval.current === removal &&
              worktrees.snapshot().archives.includes(removal)
            }
            onClose={() => setRemoval((old) => (old === removal ? null : old))}
          />
        )}
        {recycle && (
          <WorktreeRecycleReview
            key={`${recycle.action}:${recycle.record.id}:${recycle.record.revision}`}
            selection={recycle}
            current={() =>
              mounted.current &&
              currentRecycle.current === recycle &&
              (recycle.action === "archive"
                ? worktrees.snapshot().locations
                : worktrees.snapshot().archives
              ).some((item) => item === recycle.record)
            }
            onClose={() =>
              setRecycle((value) => (value === recycle ? null : value))
            }
          />
        )}
        {state.loading && <p role="status">{S.loading}</p>}
        {state.ready && !locations.length && <p>{S.empty}</p>}
        <ul className="worktree-list">
          {locations.map((location) => (
            <li key={location.id}>
              <span>
                <strong>{location.branch ?? S.currentCommit}</strong>
                <span className="worktree-path">{location.path}</span>
                <small>
                  {location.ownership === "created" ? S.created : S.existing} ·{" "}
                  {location.availability === "missing"
                    ? S.missing
                    : location.availability === "changed"
                      ? S.replaced
                      : S.unverified}
                </small>
              </span>
              <div className="worktree-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || state.working || !current()}
                  onClick={() => void act(() => use(location))}
                >
                  {S.use}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy || state.working}
                  onClick={() =>
                    void act(async () => {
                      await worktrees.check(location);
                    })
                  }
                >
                  {S.check}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy || state.working}
                  onClick={() => setForgetting(location)}
                >
                  {S.forget}
                </button>
                {location.ownership === "created" && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || !canBegin}
                    onClick={() => {
                      if (
                        canManage() &&
                        worktrees.snapshot().locations.includes(location)
                      ) {
                        setRecovering(null);
                        setRemoval(null);
                        setRecycle({ action: "archive", record: location });
                      }
                    }}
                  >
                    {S.archive}
                  </button>
                )}
              </div>
              {forgetting === location && (
                <div>
                  <p>{S.forgetNote}</p>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || state.working}
                    onClick={() =>
                      void act(async () => {
                        await worktrees.forget(location);
                        if (mounted.current) setForgetting(null);
                      })
                    }
                  >
                    {S.forget}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {state.archives.length > 0 && (
          <section>
            <h3>{S.archived}</h3>
            <p>{S.archivedNote}</p>
            <ul className="worktree-list">
              {state.archives.map((archive) => (
                <li key={archive.id}>
                  <span>
                    <strong>{archive.branch ?? S.currentCommit}</strong>
                    <span className="worktree-path">
                      {archive.originalPath}
                    </span>
                    <span className="worktree-path">
                      {archive.retainedPath}
                    </span>
                  </span>
                  <div className="worktree-actions">
                    {archive.availability !== "verified" && (
                      <p>{S.archiveUnconfirmed}</p>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy || state.working || state.loading}
                      onClick={() =>
                        void act(async () => {
                          await worktrees.checkArchive(archive);
                        })
                      }
                    >
                      {S.checkArchive}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={
                        busy || !canBegin || archive.availability !== "verified"
                      }
                      onClick={() => {
                        if (
                          canManage() &&
                          archive.availability === "verified" &&
                          worktrees.snapshot().archives.includes(archive)
                        ) {
                          setRecovering(null);
                          setRemoval(null);
                          setRecycle({ action: "restore", record: archive });
                        }
                      }}
                    >
                      {S.restore}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={
                        busy || !canBegin || archive.availability !== "verified"
                      }
                      onClick={() => {
                        if (
                          canManage() &&
                          archive.ownership === "created" &&
                          archive.availability === "verified" &&
                          worktrees.snapshot().archives.includes(archive)
                        ) {
                          setRecovering(null);
                          setRecycle(null);
                          setRemoval(archive);
                        }
                      }}
                    >
                      {S.removal.open}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        <WorktreeRecoveries
          recoveries={state.recoveries}
          disabled={busy || state.working || state.loading}
          recoveryDisabled={!canBegin}
          onRecover={(recovery) => {
            if (
              canManage() &&
              recovery.availability === "verified" &&
              worktrees.snapshot().recoveries.includes(recovery)
            ) {
              setRecycle(null);
              setRemoval(null);
              setRecovering(recovery);
            }
          }}
          onCheck={(r) => void act(() => worktrees.checkRecovery(r))}
        />
        {state.materials.length > 0 && (
          <section>
            <h3>{S.materials}</h3>
            <p>{S.materialsNote}</p>
            <ul className="worktree-list">
              {state.materials.map((material) => (
                <li key={material.operationId}>
                  <span className="worktree-path">{material.path}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy || !canBegin || !current()}
                    onClick={() =>
                      void act(async () => {
                        if (!current()) return;
                        const result = await worktrees.inspect(material.path);
                        if (!current()) return;
                        if (
                          result.repositoryRoot !== material.repositoryRoot ||
                          result.root !== material.path ||
                          !result.trees.some(
                            (tree) => tree.path === material.path,
                          )
                        )
                          throw new Error(S.changed);
                        setInspection(result);
                      })
                    }
                  >
                    {S.check}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {inspection && (
          <WorktreeCreateForm
            key={inspection.inspectionId}
            inspection={inspection}
            disabled={busy || !canBegin}
            current={current}
            onCreate={(input) => {
              if (!current() || !canBegin) return;
              void worktrees.create(input, current).catch(() => {
                if (mounted.current) setError(S.pending);
              });
            }}
            onAdopt={(path) => {
              if (!current() || !canBegin) return;
              void worktrees
                .adopt(inspection.inspectionId, path, current)
                .catch(() => {
                  if (mounted.current) setError(S.pending);
                });
            }}
          />
        )}
      </div>
    </WorkspaceDialog>
  );
}
