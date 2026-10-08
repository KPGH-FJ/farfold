import type { ConversationGroup } from "../runtime/collections";
import type { RefObject } from "react";
import { LIBRARY } from "../runtime/library_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "../library-dialogs.css";

export function MoveConversationsDialog({
  count,
  groups,
  busy,
  error,
  onMove,
  onClose,
  returnFocusRef,
}: {
  count: number;
  groups: ConversationGroup[];
  busy: boolean;
  error: string | null;
  onMove: (groupId: string) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <WorkspaceDialog
      title={LIBRARY.moveTitle(count)}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="workspace-dialog-body library-move-body">
        <div className="library-group-choices">
          {[{ id: "", name: LIBRARY.withoutGroup }, ...groups].map((group) => (
            <button
              key={group.id}
              type="button"
              disabled={busy}
              onClick={() => onMove(group.id)}
            >
              {group.name}
            </button>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </WorkspaceDialog>
  );
}
