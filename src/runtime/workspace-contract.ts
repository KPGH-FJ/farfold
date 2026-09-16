import type { RuntimeProduct } from "../components/RuntimeChooser";
import type { SidebarSessionItem } from "../components/Sidebar";
import type { HostSessionBinding } from "./host-shadow";
import type { ThemeMode } from "./theme";
import type { LifeModelWorkspace } from "./use-lifemodel-workspace";

export interface RuntimeWorkspaceProps {
  active: boolean;
  initialProjectPath: string | null;
  requestedHostSessionId: string | null;
  requestedHostSession: HostSessionBinding | null;
  onRequestedHostSessionHandled: () => void;
  onProjectPath: (path: string | null) => void;
  onSelectRuntime: (runtime: RuntimeProduct) => void;
  onSelectHostSession: (session: SidebarSessionItem) => void;
  themeMode: ThemeMode;
  onThemeMode: (mode: ThemeMode) => void;
  onOpenUpdate: () => void;
  lifeModel: LifeModelWorkspace;
  notice: { message: string; onClose: () => void } | null;
}
