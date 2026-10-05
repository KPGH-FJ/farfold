import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { AgentConnectionStatus } from "./agents";

export interface ConnectionHoldTarget {
  agentId: string;
  cwd?: string;
  serviceContext?: string;
}

const connectionKey = (target: ConnectionHoldTarget) =>
  JSON.stringify([target.agentId, target.cwd, target.serviceContext ?? null]);

/** A local view's ownership only: never starts an Agent or sends protocol work. */
export function useConnectionHold(target: ConnectionHoldTarget | null): void {
  const agentId = target?.agentId;
  const cwd = target?.cwd;
  const serviceContext = target?.serviceContext;
  useEffect(() => {
    if (!agentId) return;
    const owner = crypto.randomUUID();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const observed = new Set<string>();
    const requested = new Map<string, ConnectionHoldTarget>();
    const matches = (status: AgentConnectionStatus) =>
      status.agentId === agentId &&
      (cwd === undefined ||
        (status.cwd === cwd &&
          (status.serviceContext ?? null) === (serviceContext ?? null)));
    const release = (connection: ConnectionHoldTarget) => {
      void invoke("agent_connection_hold", {
        ...connection,
        owner,
        retain: false,
      }).catch(() => undefined);
    };
    const retain = (status: AgentConnectionStatus) => {
      if (disposed || status.state !== "ready" || !matches(status)) return;
      const connection: ConnectionHoldTarget = {
        agentId: status.agentId,
        cwd: status.cwd,
        ...(status.serviceContext
          ? { serviceContext: status.serviceContext }
          : {}),
      };
      requested.set(connectionKey(connection), connection);
      // Repeat on every ready event: the same address can now refer to a new
      // process. The backend's owner set makes repeats on one process harmless.
      void invoke<boolean>("agent_connection_hold", {
        ...connection,
        owner,
        retain: true,
      })
        .catch(() => false)
        .finally(() => {
          // Cleanup may have reached the backend before this acquisition.
          // A second idempotent release closes that late-completion window.
          if (disposed) release(connection);
        });
    };
    void listen<AgentConnectionStatus>("agent:status", ({ payload }) => {
      if (disposed || !payload || !matches(payload)) return;
      observed.add(connectionKey(payload));
      retain(payload);
    })
      .then(async (off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
        // Subscribe first; a newer event supersedes this address in the read.
        const statuses = await invoke<AgentConnectionStatus[]>("agent_status", {
          agentId,
        });
        if (disposed) return;
        for (const status of statuses)
          if (!observed.has(connectionKey(status))) retain(status);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
      for (const connection of requested.values()) release(connection);
    };
  }, [agentId, cwd, serviceContext]);
}
