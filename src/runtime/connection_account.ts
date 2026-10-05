import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import {
  mergeConnectionStatus,
  type AccountIdentity,
  type AgentConnectionStatus,
} from "./agents";

/** Only an exact, live preparation target may describe its existing account.
 * Client-selected API services have their own identity and are never replaced. */
export function connectionAccount(
  statuses: readonly AgentConnectionStatus[],
  target: {
    agentId: string;
    cwd: string;
    source?: string;
    connectionId?: string;
  },
): AccountIdentity | null {
  if (target.source) return null;
  return (
    statuses.find(
      (status) =>
        status.agentId === target.agentId &&
        status.cwd === target.cwd &&
        !status.serviceContext &&
        (target.connectionId
          ? status.connectionId === target.connectionId
          : status.purpose !== "conversation") &&
        status.state === "ready",
    )?.account ?? null
  );
}

export function useConnectionAccount(
  agentId: string,
  cwd: string | null,
  source?: string,
  active = true,
  connectionId?: string,
) {
  const key = JSON.stringify([
    agentId,
    cwd,
    source ?? null,
    connectionId ?? null,
  ]);
  const [value, setValue] = useState<{
    key: string;
    account: AccountIdentity | null;
  } | null>(null);
  useEffect(() => {
    if (!active || !cwd || source) return;
    let disposed = false;
    let off: (() => void) | undefined;
    let current: AgentConnectionStatus[] = [];
    const observed = new Set<string>();
    const statusKey = (s: AgentConnectionStatus) =>
      s.connectionId ?? JSON.stringify([s.cwd, s.serviceContext ?? null]);
    const publish = () => {
      if (!disposed)
        setValue({
          key,
          account: connectionAccount(current, { agentId, cwd, connectionId }),
        });
    };
    void listen<AgentConnectionStatus>("agent:status", ({ payload }) => {
      if (disposed || payload.agentId !== agentId) return;
      observed.add(statusKey(payload));
      current = mergeConnectionStatus(current, payload);
      publish();
    })
      .then(async (unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        off = unlisten;
        const snapshot = await invoke<AgentConnectionStatus[]>("agent_status", {
          agentId,
        });
        if (disposed) return;
        for (const status of snapshot)
          if (!observed.has(statusKey(status)))
            current = mergeConnectionStatus(current, status);
        publish();
      })
      .catch(() => {
        if (!disposed) setValue({ key, account: null });
      });
    return () => {
      disposed = true;
      off?.();
    };
  }, [key, agentId, cwd, source, active, connectionId]);
  return active && !source && value?.key === key ? value.account : null;
}
