import { invoke } from "@tauri-apps/api/core";
import type {
  HistorySearchIdentity,
  HistorySearchRequest,
} from "./history_search_types";
export interface HistorySearchPort {
  capabilities(input: { agentId: string; rowIds: string[] }): Promise<unknown>;
  start(input: HistorySearchRequest): Promise<unknown>;
  status(input: HistorySearchIdentity): Promise<unknown>;
  cancel(input: HistorySearchIdentity): Promise<unknown>;
  release(input: HistorySearchIdentity): Promise<unknown>;
}
export const historySearchPort: HistorySearchPort = {
  capabilities: (input) => invoke("history_search_capabilities", { ...input }),
  start: (input) => invoke("history_search_start", { ...input }),
  status: (input) => invoke("history_search_status", { ...input }),
  cancel: (input) => invoke("history_search_cancel", { ...input }),
  release: (input) => invoke("history_search_release", { ...input }),
};
