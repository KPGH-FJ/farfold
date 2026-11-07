import { invoke } from "@tauri-apps/api/core";
import type { SessionToolsRequest } from "./session_tools_types";

export interface SessionToolsPort {
  read(input: SessionToolsRequest): Promise<unknown>;
  status(input: SessionToolsRequest): Promise<unknown>;
}
export const sessionToolsPort: SessionToolsPort = {
  read: (input) => invoke("session_tools_read", { ...input }),
  status: (input) => invoke("session_tools_status", { ...input }),
};
