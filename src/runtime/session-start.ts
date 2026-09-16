import type {
  HostSessionCreateInput,
  HostSessionStartOptions,
} from "./host-shadow";
import {
  PI_ACP_ADAPTER_ID,
  PI_ACP_INSTALLATION_ID,
  PI_ACP_START_CONNECTION_ID,
} from "./pi-acp";

// The Host independently verifies every installation and connection reference.
export function sessionStartInput(
  workingCopyPath: string,
  options: HostSessionStartOptions,
  connection?: {
    installationId: string;
    connectionId: string;
    adapterId?: string;
  },
): HostSessionCreateInput {
  switch (options.runtimeProductId) {
    case "codex":
      if (!connection)
        throw new Error(
          "Codex requires an explicitly selected registered connection",
        );
      return { ...connection, workingCopyPath, options };
    case "pi":
      if (options.adapterId === PI_ACP_ADAPTER_ID) {
        if (
          Boolean(options.managedProvider) === Boolean(options.nativeFirstUse)
        )
          throw new Error(
            "Pi ACP 新会话必须选择已保存的 Provider 或原生 Provider 配置。",
          );
        if (
          connection &&
          (connection.installationId !== PI_ACP_INSTALLATION_ID ||
            connection.connectionId !== PI_ACP_START_CONNECTION_ID ||
            connection.adapterId !== PI_ACP_ADAPTER_ID)
        ) {
          throw new Error("Pi ACP 新建入口与所选连接不一致。");
        }
        return {
          installationId: PI_ACP_INSTALLATION_ID,
          connectionId: PI_ACP_START_CONNECTION_ID,
          workingCopyPath,
          options,
        };
      }
      throw new Error(
        "新 Pi 会话必须使用 ACP；已有 RPC 会话仍可按原绑定继续。",
      );
    case "opencode": {
      if (connection?.adapterId !== "opencode-acp-stdio-v1")
        throw new Error(
          "OpenCode requires a registered ACP connection for new sessions",
        );
      return {
        installationId: connection.installationId,
        connectionId: connection.connectionId,
        workingCopyPath,
        options: { ...options, adapterId: connection.adapterId },
      };
    }
  }
}
