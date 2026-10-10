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
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorktreeCreateForm } from "./WorktreeCreateForm";
import "./WorktreeDialog.css";

export type WorkLocationIntent = Readonly<{
  isCurrent: () => boolean;
  apply: (path: string) => Promise<boolean>;
}>;
export function WorktreeDialog({
  cwd,
  target,
  onClose,
  returnFocusRef,
}: {
  cwd: string | null;
  target: WorkLocationIntent;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const state = useWorktrees();
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
    mounted.current && currentTarget.current === target && target.isCurrent();
  const operation = state.operation;
  const canBegin =
    state.ready &&
    !state.loading &&
    !state.working &&
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
    if (!current()) throw new Error(S.changed);
    const checked = await worktrees.check(location);
    if (!current()) throw new Error(S.changed);
    if (!(await target.apply(checked.path))) throw new Error(S.changed);
    if (mounted.current && currentTarget.current === target) onClose();
  };
  const locations = state.locations;
  return (
    <WorkspaceDialog
      title={S.title}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="worktree-dialog-body">
        <p>{S.note}</p>
        {!current() && <p role="status">{S.changed}</p>}
        <div className="worktree-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || !current()}
            onClick={() =>
              void act(async () => {
                const path = await chooseDirectory(cwd ?? undefined);
                if (!path) return;
                if (!current() || !(await target.apply(path)))
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
                ? S.states[operation.state]
                : state.working
                  ? S.states.preparing
                  : S.unknownId}
            </strong>
            <p>{state.uncertain ? S.unknown : S.delayed}</p>
            {operation?.kind === "operation" && operation.code && (
              <p>
                {operation.code === "cancelled" &&
                operation.state !== "cancelled"
                  ? S.cancelRequested
                  : worktreeErrorMessage(operation.code)}
              </p>
            )}
            {operation?.kind === "operation" && operation.targetPath && (
              <p className="worktree-path">{operation.targetPath}</p>
            )}
            {operation?.kind === "operation" &&
              operation.state === "unknown" &&
              operation.settled &&
              (operation.reviewed ? (
                <p>{S.reviewed}</p>
              ) : (
                <div>
                  {reviewing === operation.operationId ? (
                    <>
                      <p>{S.reviewNote}</p>
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
                !operation.settled) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    void worktrees.cancel(state.operationId);
                  }}
                >
                  {S.cancel}
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
