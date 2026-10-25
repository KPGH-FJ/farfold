import type { WorkspaceDecisionSnapshot } from "../runtime/workspace_access_decision";
import { WORKSPACE_ACCESS as S } from "../runtime/workspace_access_strings";

/** An explicit review inside the shared dialog, never an automatic trust selection. */
export function WorkspaceAccessDecisionReview({
  snapshot,
  blocked,
  onBack,
  onConfirm,
}: {
  snapshot: Extract<
    WorkspaceDecisionSnapshot,
    { phase: "review" | "submitting" }
  >;
  blocked: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const pending = snapshot.phase === "submitting";
  const scope =
    snapshot.decision === "trust_repo"
      ? snapshot.scope.repoRoot
      : snapshot.scope.cwd;
  return (
    <section className="workspace-dialog-body">
      <strong>{S.decisions[snapshot.decision]}</strong>
      <label>
        {S.scope}
        <code style={{ overflowWrap: "anywhere" }}>{scope}</code>
      </label>
      <p>{S.persistent}</p>
      <p>{snapshot.decision === "decline" ? S.declineEffect : S.grantEffect}</p>
      {pending && <p role="status">{S.deciding}</p>}
      <div className="conversation-option-review">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending}
          onClick={onBack}
        >
          {S.back}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || blocked}
          onClick={onConfirm}
        >
          {S.confirmDecision}
        </button>
      </div>
    </section>
  );
}
