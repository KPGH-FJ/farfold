import {
  BookOpenIcon,
  FolderIcon,
  KeyIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { STRINGS } from "../runtime/strings";
import { SETTINGS_PRESENTATION as P } from "../runtime/settings_presentation_strings";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { RefObject } from "react";

export const generalShortcuts = [
  [STRINGS.general.shortcutNew, "⌘ N"],
  [STRINGS.general.shortcutSearch, "⌘ K"],
  [P.openSettings, "⌘ ,"],
  [P.searchAlias, "⌘ ⇧ P"],
  [P.closeDialog, "Esc"],
  [STRINGS.general.shortcutSend, "Enter"],
  [STRINGS.general.shortcutNewline, "⇧ Enter"],
] as const;

export function GeneralSettingsDialog({
  page,
  onClose,
  returnFocusRef,
}: {
  page: "shortcuts" | "privacy";
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const icons = [FolderIcon, BookOpenIcon, KeyIcon, SparkleIcon];
  return (
    <WorkspaceDialog
      title={page === "shortcuts" ? STRINGS.general.shortcuts : P.privacy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {page === "shortcuts" ? (
        <dl className="settings-shortcut-list">
          {generalShortcuts.map(([label, keys]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <kbd>{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="settings-privacy-list">
          {P.data.map(({ title, text }, index) => {
            const Icon = icons[index];
            return (
              <section key={title}>
                <Icon size={21} aria-hidden="true" />
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </section>
            );
          })}
          <p className="general-caption">{P.dataScope}</p>
        </div>
      )}
      <footer>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {page === "shortcuts" ? P.close : P.understood}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
