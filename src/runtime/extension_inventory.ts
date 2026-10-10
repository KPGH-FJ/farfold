import { invoke } from "@tauri-apps/api/core";
import { parseExtensionCapabilities } from "./extension_inventory_types";
import type { InventoryRequest } from "./extension_inventory_types";
export interface InventoryPort {
  read(request: InventoryRequest & { selectionId: string }): Promise<unknown>;
  status(request: InventoryRequest): Promise<unknown>;
  cancel(request: InventoryRequest): Promise<unknown>;
}
export const inventoryPort: InventoryPort = {
  read: (request) => invoke("agent_extension_inventory_read", { ...request }),
  status: ({ agentId, requestId }) =>
    invoke("agent_extension_inventory_status", { agentId, requestId }),
  cancel: ({ agentId, requestId }) =>
    invoke("agent_extension_inventory_cancel", { agentId, requestId }),
};
export async function extensionCapabilities(agentId: string) {
  return parseExtensionCapabilities(
    await invoke("agent_extension_capabilities", { agentId }),
  );
}
