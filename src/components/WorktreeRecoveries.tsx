import type { WorktreeRecovery } from "../runtime/worktree_types";
import { WORKTREE_STRINGS as S } from "../runtime/worktree_strings";
const M = S.removal;
export function WorktreeRecoveries({
  recoveries,
  disabled,
  onCheck,
  onRecover,
  recoveryDisabled,
}: {
  recoveries: readonly WorktreeRecovery[];
  disabled: boolean;
  recoveryDisabled: boolean;
  onCheck: (recovery: WorktreeRecovery) => void;
  onRecover: (recovery: WorktreeRecovery) => void;
}) {
  if (!recoveries.length) return null;
  return (
    <section aria-label={M.recoveries}>
      <h3>{M.recoveries}</h3>
      <p>{M.recoveryNote}</p>
      <p>{S.recovery.checkFirst}</p>
      <ul className="worktree-list">
        {recoveries.map((r) => (
          <li key={r.id}>
            <span>
              <strong>{r.branch ?? S.currentCommit}</strong>
              <span className="worktree-path">{r.path}</span>
              <small>
                {r.availability === "verified"
                  ? M.verified
                  : r.availability === "missing"
                    ? M.missing
                    : r.availability === "changed"
                      ? M.changed
                      : M.unconfirmed}
              </small>
              <details>
                <summary>{M.hashes}</summary>
                <p>{M.summary(r.bundleBytes)}</p>
                <dl className="worktree-paths">
                  <dt>{S.recycleOriginal}</dt>
                  <dd>{r.originalPath}</dd>
                  <dt>{S.recycleRetained}</dt>
                  <dd>{r.retainedPath}</dd>
                  <dt>{M.bundleHash}</dt>
                  <dd>{r.bundleSha256}</dd>
                  <dt>{M.manifestHash}</dt>
                  <dd>{r.manifestSha256}</dd>
                </dl>
              </details>
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onCheck(r);
              }}
            >
              {M.check}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                disabled || recoveryDisabled || r.availability !== "verified"
              }
              onClick={() => {
                if (
                  !disabled &&
                  !recoveryDisabled &&
                  r.availability === "verified"
                )
                  onRecover(r);
              }}
            >
              {S.recovery.open}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
