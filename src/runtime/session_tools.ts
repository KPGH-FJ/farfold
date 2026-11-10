import { invoke } from "@tauri-apps/api/core";
import type { SessionToolsRequest } from "./session_tools_types";

export interface SessionToolsPort {
  read(input: SessionToolsRequest): Promise<unknown>;
  status(input: SessionToolsRequest): Promise<unknown>;
}

function commandArgs({
  extensionName,
  configuration,
  ...target
}: SessionToolsRequest) {
  return { ...target, scope: { extensionName, configuration } };
}

export const sessionToolsPort: SessionToolsPort = {
  read: (input) => invoke("session_tools_read", commandArgs(input)),
  status: (input) => invoke("session_tools_status", commandArgs(input)),
};
