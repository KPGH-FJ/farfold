import { useEffect, useRef, useState } from "react";
import { HostWorkspaceConnection } from "./host-workspace-connection";
import { hostShadowQaEnabled, type HostShadowState } from "./host-shadow";
import { traceAfterPaint } from "./performance-trace";

export function useHostWorkspace() {
  const [state, setState] = useState<HostShadowState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const connection = useRef<HostWorkspaceConnection | null>(null);
  useEffect(() => {
    const current = new HostWorkspaceConnection(
      (next) => {
        traceAfterPaint("sidebar_ready");
        setState(next);
        setUnavailable(false);
      },
      () => setUnavailable(true),
    );
    connection.current = current;
    void current.start().catch(() => undefined);
    return () => {
      if (connection.current === current) connection.current = null;
      void current.stop();
    };
  }, []);
  return {
    state,
    unavailable,
    reconnectForQa: async (operation: () => Promise<void>) => {
      if (!hostShadowQaEnabled || !connection.current)
        throw new Error("Host QA Channel 尚未就绪。");
      return connection.current.reconnectForQa(operation);
    },
  };
}
export type HostWorkspaceChannel = ReturnType<typeof useHostWorkspace>;
