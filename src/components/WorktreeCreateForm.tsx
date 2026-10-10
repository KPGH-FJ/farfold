import { useRef, useState } from "react";
import { chooseDirectory } from "../runtime/dialogs";
import { worktrees } from "../runtime/worktrees";
import type {
  WorktreeCreate,
  WorktreeInspection,
  WorktreeRef,
} from "../runtime/worktree_types";
import {
  WORKTREE_STRINGS as S,
  worktreeBlockerMessage,
  worktreeFailureMessage,
} from "../runtime/worktree_strings";

export function WorktreeCreateForm({
  inspection,
  disabled,
  current,
  onCreate,
  onAdopt,
}: {
  inspection: WorktreeInspection;
  disabled: boolean;
  current: () => boolean;
  onCreate: (input: WorktreeCreate) => void;
  onAdopt: (path: string) => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [directory, setDirectory] = useState("");
  const [refs, setRefs] = useState<readonly WorktreeRef[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [selected, setSelected] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useRef({ inspection, disabled, current });
  state.current = { inspection, disabled, current };
  const busy = useRef(false);
  const allowed = () =>
    state.current.inspection === inspection &&
    !state.current.disabled &&
    state.current.current();
  const run = async (action: () => Promise<void>) => {
    if (busy.current || !allowed()) return;
    busy.current = true;
    setReading(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (allowed()) setError(worktreeFailureMessage(reason));
    } finally {
      busy.current = false;
      setReading(false);
    }
  };
  const branch = refs.find((item) => item.ref === selected);
  const oid = branch?.oid ?? inspection.head.oid;
  const valid =
    !!parent &&
    !!directory.trim() &&
    !/[\\/\0]/.test(directory) &&
    ![".", ".."].includes(directory) &&
    (mode === "new" ? !!name.trim() && !!oid : !!branch && !branch.inUse);
  return (
    <section className="worktree-create">
      <p className="worktree-path">{inspection.root}</p>
      <h3>{S.repositoryLocations}</h3>
      <ul className="worktree-list">
        {inspection.trees.map((tree) => (
          <li key={tree.path}>
            <span>
              <strong>{tree.branch ?? S.currentCommit}</strong>
              <span className="worktree-path">{tree.path}</span>
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled || reading || tree.locked}
              onClick={() => {
                if (allowed()) onAdopt(tree.path);
              }}
            >
              {S.adopt}
            </button>
          </li>
        ))}
      </ul>
      {inspection.blockers.length ? (
        <>
          <p role="status">{S.blocked}</p>
          <details>
            <summary>{S.details}</summary>
            <ul>
              {inspection.blockers.map((code) => (
                <li key={code}>{worktreeBlockerMessage(code)}</li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!allowed() || busy.current || !valid || !oid) return;
            onCreate({
              inspectionId: inspection.inspectionId,
              parentPath: parent,
              directoryName: directory,
              branch:
                mode === "new"
                  ? { kind: "new", name, startOid: oid }
                  : {
                      kind: "existing",
                      ref: branch!.ref,
                      expectedOid: branch!.oid,
                    },
            });
          }}
        >
          <h3>{S.create}</h3>
          <p>{S.noSetup}</p>
          <label>
            {S.branch}
            <select
              value={mode}
              disabled={disabled || reading}
              onChange={(event) => {
                if (allowed())
                  setMode(
                    event.target.value === "existing" ? "existing" : "new",
                  );
              }}
            >
              <option value="new">{S.newBranch}</option>
              <option value="existing">{S.existingBranch}</option>
            </select>
          </label>
          {mode === "new" && (
            <label>
              {S.branchName}
              <input
                maxLength={1024}
                value={name}
                disabled={disabled || reading}
                onChange={(event) => {
                  if (allowed()) setName(event.target.value);
                }}
              />
            </label>
          )}
          <label>
            {mode === "new" ? S.start : S.existingBranch}
            <select
              value={selected}
              disabled={disabled || reading}
              onChange={(event) => {
                if (allowed()) setSelected(event.target.value);
              }}
            >
              <option value="">
                {mode === "new" ? S.currentCommit : S.existingBranch}
              </option>
              {refs.map((ref) => (
                <option
                  key={ref.ref}
                  value={ref.ref}
                  disabled={mode === "existing" && ref.inUse}
                >
                  {ref.ref.replace(/^refs\/heads\//, "")}
                  {ref.inUse ? ` (${S.inUse})` : ""}
                </option>
              ))}
            </select>
          </label>
          {cursor !== null && refs.length < 1000 && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled || reading}
              onClick={() =>
                void run(async () => {
                  const page = await worktrees.refs(
                    inspection.inspectionId,
                    cursor,
                  );
                  if (!allowed()) return;
                  const next = [
                    ...refs,
                    ...page.refs.filter(
                      (ref) => !refs.some((old) => old.ref === ref.ref),
                    ),
                  ];
                  setRefs(next);
                  setCursor(
                    page.nextCursor === cursor ? null : page.nextCursor,
                  );
                })
              }
            >
              {S.more}
            </button>
          )}
          {cursor !== null && refs.length >= 1000 && (
            <p role="status">{S.refsLimit}</p>
          )}
          <label>
            {S.parent}
            <button
              type="button"
              className="btn btn-ghost worktree-path"
              disabled={disabled || reading}
              onClick={() =>
                void run(async () => {
                  const path = await chooseDirectory(parent || inspection.root);
                  if (path && allowed()) setParent(path);
                })
              }
            >
              {parent || S.selectParent}
            </button>
          </label>
          <label>
            {S.directory}
            <input
              maxLength={255}
              value={directory}
              disabled={disabled || reading}
              onChange={(event) => {
                if (allowed()) setDirectory(event.target.value);
              }}
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!valid || disabled || reading}
          >
            {S.create}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
