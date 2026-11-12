import type { ConfigCheck } from "./config_check";
import type { ThreadState } from "./session_types";

/** `session_open` result. */
export interface OpenResult {
  nativeSessionId: string;
  connectionId?: string;
  sessionOperations?: import("./session_fork_types").SessionOperations;
  workspaceAccess?:
    import("./workspace_access_types").WorkspaceAccessCapability | null;
  identityRead?: import("./session_identity_types").IdentityReadSupport | null;
  sessionToolInventory?:
    import("./session_tools_types").SessionToolInventoryCapability | null;
  /** Canonicalized cwd — session keys must be built from this. */
  cwd: string;
  configOptions: unknown;
  configOptionsModern?: boolean;
  modes?: unknown;
  models?: unknown;
  meta?: unknown;
  resumed: boolean;
  /** Current official empty-history fact verified by the owning backend open. */
  historyEmptyConfirmed?: boolean;
  warnings: string[];
  configCheck?: ConfigCheck;
  permissionConfigId?: string;
  permissionState?: ThreadState["permissionState"];
  permissionEffect?: unknown;
  service?: import("./credentials").ServiceIdentity | null;
  serviceContext?: string | null;
}
