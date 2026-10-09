import { WorkspaceDialog } from "./WorkspaceDialog";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";

export interface ProgramChange {
  scope: string;
  current: string;
  candidate: string;
  update?: boolean;
  apply: () => Promise<unknown>;
}
/** Uses the existing program executor only after the displayed target is confirmed. */
export function ProgramChangeReview({
  change,
  busy,
  valid,
  error,
  onConfirm,
  onClose,
}: {
  change: ProgramChange;
  busy: boolean;
  valid: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <WorkspaceDialog
      title={change.update ? U.updateProgram : U.changeProgram}
      busy={busy}
      onClose={onClose}
    >
      <div className="workspace-dialog-body agent-program-change">
        <dl className="agent-current-facts">
          <div>
            <dt>{U.currentProgram}</dt>
            <dd>{change.current}</dd>
          </div>
          <div>
            <dt>{U.candidateProgram}</dt>
            <dd>{change.candidate}</dd>
          </div>
        </dl>
        <p>{U.programScope}</p>
        <details>
          <summary>{U.evidenceScope}</summary>
          <p>{U.programWorking}</p>
        </details>
        {!busy && !valid && <p role="alert">{U.programChanged}</p>}
        {error && (
          <p role="alert" className="ac-error">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
          {U.cancel}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy || !valid}
          onClick={onConfirm}
        >
          {change.update ? U.confirmUpdate : U.confirmChange}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
