import { invoke } from "@tauri-apps/api/core";

type Key = { agentId: string; requestId: string };
export interface PluginManagementPort {
  sources(input: Key & { selectionId: string; cwd: string }): Promise<unknown>;
  inventory(
    input: Key & { sourceRequestId: string; sourceId: number },
  ): Promise<unknown>;
  inspect(
    input: Key & {
      inventoryRequestId: string;
      itemId: number;
      install: boolean;
    },
  ): Promise<unknown>;
  confirm(input: Key & { reviewId: string }): Promise<unknown>;
  recheck(input: Key & { operationId: string }): Promise<unknown>;
  status(input: Key): Promise<unknown>;
  cancel(input: Key): Promise<unknown>;
}
// Method names and command semantics remain in the backend's reviewed capability.
export const pluginManagementPort: PluginManagementPort = {
  sources: (input) => invoke("agent_plugin_sources_read", { ...input }),
  inventory: (input) => invoke("agent_plugin_inventory_read", { ...input }),
  inspect: (input) => invoke("agent_plugin_change_inspect", { ...input }),
  confirm: (input) => invoke("agent_plugin_change_confirm", { ...input }),
  recheck: (input) => invoke("agent_plugin_change_recheck", { ...input }),
  status: (input) => invoke("agent_plugin_operation_status", { ...input }),
  cancel: (input) => invoke("agent_plugin_operation_cancel", { ...input }),
};
