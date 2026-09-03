import { invoke } from "@tauri-apps/api/core";
import type { OpenCodeRuntimeStatus } from "./opencode";
import type { RuntimeStatus } from "./pi";

export type HostManagedRuntimeStopResult =
  | { runtimeProductId: "pi"; status: RuntimeStatus }
  | { runtimeProductId: "opencode"; status: OpenCodeRuntimeStatus };

export async function stopHostPiRuntime(): Promise<RuntimeStatus> {
  const result = await invoke<HostManagedRuntimeStopResult>(
    "host_managed_runtime_stop",
    { input: { runtimeProductId: "pi" } },
  );
  if (result.runtimeProductId !== "pi") {
    throw new Error("Host returned a non-Pi Runtime stop result.");
  }
  return result.status;
}

export async function stopHostOpenCodeRuntime(): Promise<OpenCodeRuntimeStatus> {
  const result = await invoke<HostManagedRuntimeStopResult>(
    "host_managed_runtime_stop",
    { input: { runtimeProductId: "opencode" } },
  );
  if (result.runtimeProductId !== "opencode") {
    throw new Error("Host returned a non-OpenCode Runtime stop result.");
  }
  return result.status;
}
