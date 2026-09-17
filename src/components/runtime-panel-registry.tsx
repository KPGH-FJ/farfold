import type { ComponentType } from "react";
import type {
  RuntimePanelProps,
  RuntimeWorkspaceProps,
} from "../runtime/workspace-contract";
import type { HostWorkspaceChannel } from "../runtime/use-host-workspace";
import type { RuntimeProduct } from "./RuntimeChooser";
import { CodexWorkspace } from "./CodexWorkspace";
import { OpenCodePanel } from "./OpenCodePanel";
import { PiWorkspace } from "./PiWorkspace";

/** A panel that renders inside the shared Workspace shell. */
export interface SharedShellPanelEntry {
  product: RuntimeProduct;
  sharedShell: true;
  Panel: ComponentType<RuntimePanelProps>;
}

/** A panel that still owns its own shell chrome until its ACP stage lands. */
export interface OwnShellPanelEntry {
  product: RuntimeProduct;
  sharedShell: false;
  Panel: ComponentType<
    RuntimeWorkspaceProps & { hostChannel: HostWorkspaceChannel }
  >;
}

export type RuntimePanelEntry = SharedShellPanelEntry | OwnShellPanelEntry;

// The single extension point for Runtime bodies in the unified shell. A panel
// joins the shared shell once its Runtime runs on the ACP/Host contract; until
// then it keeps its own chrome and truthful capability states.
export const RUNTIME_PANELS: readonly RuntimePanelEntry[] = [
  { product: "opencode", sharedShell: true, Panel: OpenCodePanel },
  { product: "pi", sharedShell: false, Panel: PiWorkspace },
  { product: "codex", sharedShell: false, Panel: CodexWorkspace },
];

export function sharedShellPanel(
  product: RuntimeProduct,
): SharedShellPanelEntry | undefined {
  return RUNTIME_PANELS.find(
    (entry): entry is SharedShellPanelEntry =>
      entry.product === product && entry.sharedShell,
  );
}

export function ownShellPanels(): OwnShellPanelEntry[] {
  return RUNTIME_PANELS.filter(
    (entry): entry is OwnShellPanelEntry => !entry.sharedShell,
  );
}
