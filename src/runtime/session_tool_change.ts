import { invoke } from "@tauri-apps/api/core";
import type { SessionToolsTarget } from "./session_tools_types";
import type {
  SessionToolChange,
  SessionToolChangeRequest,
} from "./session_tool_change_types";

export interface SessionToolChangePort {
  start(
    request: SessionToolChangeRequest,
    change: SessionToolChange,
  ): Promise<unknown>;
  status(request: SessionToolChangeRequest): Promise<unknown>;
  items(target: SessionToolsTarget): Promise<unknown>;
}
export const sessionToolChangePort: SessionToolChangePort = {
  start: (request, change) =>
    invoke("session_tool_change_start", { ...request, change }),
  status: (request) => invoke("session_tool_change_status", { ...request }),
  items: (target) => invoke("session_tool_change_items", { ...target }),
};
