import { createContext } from "react";

/** A searchable child menu can leave the popup's scrolling DOM while staying
 * inside its dismissal boundary. Other menus and native dialogs are unchanged. */
export const WorkspacePopoverScope = createContext<{
  host: HTMLElement;
  register: (panel: HTMLElement) => () => void;
} | null>(null);
