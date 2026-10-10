import type {
  InventoryOperation,
  McpInventory,
  InventoryRequest,
} from "./extension_inventory_types";
export const request: InventoryRequest = {
  kind: "mcp",
  agentId: "fixture-agent",
  cwd: "/controlled/project",
  requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};
export const ready = (
  r = request,
): InventoryOperation & { snapshot: McpInventory } => ({
  ...r,
  state: "ready",
  settled: true,
  snapshot: {
    observedAtMs: 1000,
    scope: "officialCliConfigurationForDirectory",
    source: "officialCli",
    complete: true,
    sessionApplicability: "unverified",
    items: [
      {
        id: 0,
        name: "example",
        transport: "stdio",
        reportedEnabled: true,
        reportedAuth: "notLoggedIn",
        origin: "unreported",
        configurationLayer: "unreported",
        connection: "unverified",
        tools: "unreported",
      },
    ],
  },
});
export function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
