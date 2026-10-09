import type { ConversationGroup } from "../runtime/collections";
import { useState, type RefObject } from "react";
import { LIBRARY } from "../runtime/library_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import "../library-dialogs.css";
import "../settings-library-redesign.css";
import { SETTINGS_REDESIGN as R } from "../runtime/settings_redesign_strings";

export function MoveConversationsDialog({
  count,
  groups,
  busy,
  error,
  onMove,
  onClose,
  returnFocusRef,
  rows,
}: {
  count: number;
  groups: ConversationGroup[];
  busy: boolean;
  error: string | null;
  onMove: (groupId: string) => void;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  rows?: { title: string; groupId: string }[];
}) {
  const current =
    rows?.length && rows.every((row) => row.groupId === rows[0].groupId)
      ? rows[0].groupId
      : null;
  const [destination, setDestination] = useState<string | null>(null);
  const unchanged = current !== null && destination === current;
  const valid =
    destination !== null &&
    (destination === "" || groups.some((group) => group.id === destination));
  return (
    <WorkspaceDialog
      title={LIBRARY.moveTitle(count)}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      <div className="workspace-dialog-body library-move-body">
        {rows && (
          <>
            <ul className="library-target-list" aria-label={R.targets}>
              {rows.map((row, index) => (
                <li key={index}>{row.title}</li>
              ))}
            </ul>
            <p className="library-move-context">
              {R.currentGroup}：
              {current === null
                ? R.mixedGroup
                : (groups.find((group) => group.id === current)?.name ??
                  LIBRARY.noGroup)}
            </p>
          </>
        )}
        <p>{LIBRARY.groupScopeHint}</p>
        <div
          className="library-group-choices"
          role="group"
          aria-label={R.destination}
        >
          {[{ id: "", name: LIBRARY.withoutGroup }, ...groups].map((group) => (
            <button
              key={group.id}
              type="button"
              disabled={busy}
              aria-pressed={destination === group.id}
              onClick={() => setDestination(group.id)}
            >
              {group.name}
            </button>
          ))}
        </div>
        {unchanged && <p role="status">{R.unchangedGroup}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={onClose}
        >
          {LIBRARY.cancel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !valid || unchanged}
          onClick={() => {
            if (valid && !busy && !unchanged) onMove(destination!);
          }}
        >
          {R.moveConfirm}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
