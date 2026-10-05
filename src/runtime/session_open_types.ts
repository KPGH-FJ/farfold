import type { ConfigCheck } from "./config_check";
import type { ThreadState } from "./session_types";

/** `session_open` result. */
export interface OpenResult {
  nativeSessionId: string;
  connectionId?: string;
  /** Canonicalized cwd — session keys must be built from this. */
  cwd: string;
  configOptions: unknown;
  modes?: unknown;
  models?: unknown;
  meta?: unknown;
  resumed: boolean;
  warnings: string[];
  configCheck?: ConfigCheck;
  permissionConfigId?: string;
  permissionState?: ThreadState["permissionState"];
  service?: import("./credentials").ServiceIdentity | null;
  serviceContext?: string | null;
}
