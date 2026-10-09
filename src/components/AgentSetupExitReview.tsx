import { WorkspaceDialog } from "./WorkspaceDialog";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";
export function AgentSetupExitReview({
  onContinue,
  onDiscard,
  onKeep,
}: {
  onContinue: () => void;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  return (
    <WorkspaceDialog title={U.setupUnsaved} onClose={onContinue}>
      <div className="workspace-dialog-body">
        <p>{U.setupUnsavedHint}</p>
      </div>
      <footer>
        <button className="btn btn-ghost" onClick={onDiscard}>
          {U.setupDiscard}
        </button>
        <button className="btn btn-ghost" onClick={onKeep}>
          {U.setupKeep}
        </button>
        <button className="btn btn-primary" onClick={onContinue}>
          {U.customContinue}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
