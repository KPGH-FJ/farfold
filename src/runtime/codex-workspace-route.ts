import type { HostSessionBinding } from "./host-shadow";

/** No current connection, installation preference or model may change this route. */
export function codexWorkspaceRoute(
  binding: Pick<HostSessionBinding, "runtimeProductId" | "adapterId"> | null,
): "direct" | "acp" | "unsupported" {
  if (!binding) return "acp";
  if (binding.runtimeProductId !== "codex") return "unsupported";
  if (binding.adapterId === "codex-app-server") return "direct";
  if (binding.adapterId === "codex-acp-stdio-v1") return "acp";
  return "unsupported";
}
