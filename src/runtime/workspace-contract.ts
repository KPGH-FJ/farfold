import type { RuntimeProduct } from "../components/RuntimeChooser";
import type { SidebarSessionItem } from "../components/Sidebar";
import type { HostSessionBinding } from "./host-shadow";
import type { ThemeMode } from "./theme";
import type { LifeModelWorkspace } from "./use-lifemodel-workspace";

export interface RuntimeWorkspaceProps {
  active: boolean;
  initialProjectPath: string | null;
  /** Non-null only for the panel owning the requested Session's Runtime. */
  requestedHostSessionId: string | null;
  requestedHostSession: HostSessionBinding | null;
  /**
   * Acknowledge the request for `sessionId`. Clearing is id-scoped: a newer
   * request that arrived while this one was in flight is not clobbered.
   */
  onRequestedHostSessionHandled: (sessionId: string) => void;
  /** Host restore pointer, for panels that display it without opening. */
  restoredHostSession: HostSessionBinding | null;
  onProjectPath: (path: string | null) => void;
  onSelectRuntime: (runtime: RuntimeProduct) => void;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  onOpenUpdate: () => void;
  lifeModel: LifeModelWorkspace;
  notice: { message: string; onClose: () => void } | null;
}

// Unified-shell contract: the Workspace owns the app-shell grid, the shared
// Sidebar and session navigation. A Runtime panel renders `<main>` plus its
// runtime-specific overlays, and reports the pieces of chrome state that the
// shared Sidebar needs (active session, busy flags, provider summary).

export interface PanelShellMeta {
  /** Session the panel currently treats as active, for Sidebar highlight. */
  activeSessionKey: string | null;
  /** Session being opened/created right now, for Sidebar highlight. */
  openingSessionKey?: string | null;
  /** Lifecycle operation in flight (start/stop/submit/reconcile). */
  busy: boolean;
  /** Native Turn in flight; blocks same-Runtime session navigation. */
  working: boolean;
  providerCount: number;
  settingsTitle?: string;
  settingsSubtitle?: string;
  /** Whether the panel is showing its SessionContextPanel column. */
  contextOpen: boolean;
}

/** Actions the shared Sidebar delegates to the active Runtime panel. */
export interface PanelShellActions {
  newSession?: () => void;
  openConnections?: () => void;
  togglePinned?: (session: SidebarSessionItem) => void;
  archive?: (session: SidebarSessionItem) => Promise<void>;
  restore?: (session: SidebarSessionItem) => Promise<void>;
}

export interface RuntimePanelProps extends RuntimeWorkspaceProps {
  /** The Runtime product this mounted panel instance serves. */
  product: RuntimeProduct;
  /** Per-product slot the panel fills each commit with its current actions. */
  shellActions: { current: PanelShellActions };
  /** Report chrome state changes to the shared Sidebar/shell. */
  onShellMeta: (meta: PanelShellMeta) => void;
}
