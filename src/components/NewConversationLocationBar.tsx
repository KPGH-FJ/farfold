import { CaretDownIcon, FolderSimpleIcon, XIcon } from "@phosphor-icons/react";
import { basename } from "../runtime/sessions";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { REDESIGN as R } from "../runtime/redesign_strings";
import type { WorkLocationIntent } from "../runtime/worktree_management";
import type { PreparationDraftTarget } from "../runtime/draft_preparation";
import { WorkLocationPicker } from "./WorkLocationPicker";
import { WorktreePreparationControl } from "./WorktreePreparationControl";

export function NewConversationLocationBar({
  folder,
  active,
  disabled,
  preparationDisabled,
  onPick,
  onClear,
  beginWorkLocation,
  beginPreparation,
}: {
  folder: string | null;
  active: boolean;
  disabled: boolean;
  preparationDisabled: boolean;
  onPick: () => void;
  onClear: () => void;
  beginWorkLocation: () => WorkLocationIntent | null;
  beginPreparation: () => PreparationDraftTarget | null;
}) {
  return (
    <div className="workspace-folder-bar">
      <span className="workspace-folder-label">{W.workingFolder}</span>
      <button
        type="button"
        className={`workspace-folder-button${folder ? " selected" : ""}`}
        aria-label={folder ? W.changeFolder : W.folder}
        title={folder ?? undefined}
        disabled={disabled}
        onClick={onPick}
      >
        <FolderSimpleIcon size={18} />
        <span>{folder ? basename(folder) : W.folder}</span>
        <CaretDownIcon size={12} />
      </button>
      {folder && (
        <button
          type="button"
          className="workspace-folder-clear icon-btn"
          aria-label={W.clearFolder}
          disabled={disabled}
          onClick={onClear}
        >
          <XIcon size={14} />
        </button>
      )}
      <WorkLocationPicker
        cwd={folder}
        disabled={!active || disabled}
        begin={beginWorkLocation}
      />
      <WorktreePreparationControl
        disabled={!active || !folder || disabled || preparationDisabled}
        begin={beginPreparation}
      />
      <span className="workspace-folder-hint">{R.folderHint}</span>
    </div>
  );
}
