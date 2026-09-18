import type { ComponentType } from "react";
import type { RuntimePanelProps } from "../runtime/workspace-contract";
import type { RuntimeProduct } from "./RuntimeChooser";
import { MigratingRuntimePanel } from "./MigratingRuntimePanel";
import { OpenCodePanel } from "./OpenCodePanel";

export interface RuntimePanelEntry {
  product: RuntimeProduct;
  Panel: ComponentType<RuntimePanelProps>;
}

// The single extension point for Runtime bodies in the unified shell. A panel
// serves real work once its Runtime runs on the ACP/Host contract; until then
// it shows the truthful migration placeholder. Pi and Codex regain their
// panels in their own ACP stages.
export const RUNTIME_PANELS: readonly RuntimePanelEntry[] = [
  { product: "opencode", Panel: OpenCodePanel },
  { product: "pi", Panel: MigratingRuntimePanel },
  { product: "codex", Panel: MigratingRuntimePanel },
];

export function runtimePanelEntry(
  product: RuntimeProduct,
): RuntimePanelEntry | undefined {
  return RUNTIME_PANELS.find((entry) => entry.product === product);
}
