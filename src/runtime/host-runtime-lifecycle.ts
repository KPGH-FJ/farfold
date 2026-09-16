import { invoke } from "@tauri-apps/api/core";
import type { OpenCodeRuntimeStatus, OpenCodeRecoveryTarget } from "./opencode";
import type { RuntimeStatus } from "./pi";
import type { OpenCodeAcpStatus } from "./opencode-acp";
import type { PiAcpStatus, PiAcpTarget, PiAcpTurnTarget } from "./pi-acp";

export type HostManagedRuntimeStopResult =
  | { runtimeProductId: "pi"; status: RuntimeStatus | PiAcpStatus }
  | {
      runtimeProductId: "opencode";
      status: OpenCodeRuntimeStatus | OpenCodeAcpStatus;
    };

export async function stopHostPiRuntime(): Promise<RuntimeStatus> {
  const result = await invoke<HostManagedRuntimeStopResult>(
    "host_managed_runtime_stop",
    { input: { runtimeProductId: "pi" } },
  );
  if (result.runtimeProductId !== "pi" || !("state" in result.status)) {
    throw new Error("Host returned a non-Pi Runtime stop result.");
  }
  return result.status;
}

export async function stopHostPiAcpRuntime(
  target: PiAcpTarget | PiAcpTurnTarget,
): Promise<PiAcpStatus> {
  const result = await invoke<HostManagedRuntimeStopResult>(
    "host_managed_runtime_stop",
    {
      input: {
        runtimeProductId: "pi",
        ...("turnId" in target ? { recovery: target } : { session: target }),
      },
    },
  );
  if (
    result.runtimeProductId !== "pi" ||
    !("nativeSession" in result.status) ||
    !("configOptions" in result.status)
  ) {
    throw new Error("Host 返回的不是 Pi ACP 连接停止结果。");
  }
  return result.status;
}

export async function stopHostOpenCodeRuntime(
  recovery?: OpenCodeRecoveryTarget,
): Promise<OpenCodeRuntimeStatus> {
  const result = await invoke<HostManagedRuntimeStopResult>(
    "host_managed_runtime_stop",
    {
      input: {
        runtimeProductId: "opencode",
        ...(recovery ? { recovery } : {}),
      },
    },
  );
  if (
    result.runtimeProductId !== "opencode" ||
    !("projectPath" in result.status)
  ) {
    throw new Error("Host returned a non-OpenCode Runtime stop result.");
  }
  return result.status;
}

export async function stopHostOpenCodeAcpRuntime(
  target: OpenCodeRecoveryTarget | Omit<OpenCodeRecoveryTarget, "turnId">,
): Promise<OpenCodeAcpStatus> {
  const result = await invoke<HostManagedRuntimeStopResult>(
    "host_managed_runtime_stop",
    {
      input: {
        runtimeProductId: "opencode",
        ...("turnId" in target ? { recovery: target } : { session: target }),
      },
    },
  );
  if (
    result.runtimeProductId !== "opencode" ||
    !("configOptions" in result.status)
  ) {
    throw new Error("Host returned a non-ACP Runtime stop result.");
  }
  return result.status;
}
