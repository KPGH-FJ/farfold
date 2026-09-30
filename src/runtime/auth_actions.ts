import { Channel, invoke } from "@tauri-apps/api/core";
import type { AuthTarget } from "./auth_activity";
import {
  authenticationActivity,
  invalidateAuthentication,
} from "./authentication";
import {
  authRun,
  agentLogout,
  ptyAwait,
  ptyClose,
  type AuthMethodInfo,
  type PtyChunk,
} from "./agents";

export function beginAuthentication(input: {
  target: AuthTarget;
  method: Pick<AuthMethodInfo, "id" | "kind">;
  manual?: boolean;
  logout?: boolean;
  onChanged: () => Promise<void>;
}) {
  const { target, method } = input;
  const activity = authenticationActivity(target.agentId);
  const attemptId = crypto.randomUUID();
  activity.begin(
    target,
    input.manual ? `manual:${method.id}` : method.id,
    attemptId,
  );
  invalidateAuthentication(target.agentId);
  const reconnect = async () => {
    // Always return to the initiating directory, never the currently visible one.
    await invoke("agent_disconnect", { agentId: target.agentId });
    await invoke("agent_connect", { agentId: target.agentId, cwd: target.cwd });
    await input.onChanged();
  };
  if (method.kind === "terminal" || input.manual) {
    activity.terminal({
      start: (output) => {
        const channel = new Channel<PtyChunk>();
        channel.onmessage = (chunk) => {
          if (typeof chunk.data === "string") output(chunk.data);
        };
        return input.manual
          ? invoke<string>("auth_manual_run", {
              ...target,
              methodId: method.id,
              attemptId,
              onOutput: channel,
            })
          : authRun(target.agentId, method.id, {
              ...target,
              attemptId,
              viaTerminal: true,
              onOutput: channel,
            }).then((result) => result.ptyId ?? "");
      },
      wait: ptyAwait,
      close: ptyClose,
      reconnect,
    });
  } else {
    void activity.protocol({
      run: (unknown) => {
        const channel = new Channel<PtyChunk>();
        channel.onmessage = (chunk) => {
          if (chunk.authStatus === "unknown") unknown();
        };
        const options = { ...target, attemptId, onOutput: channel };
        return input.logout
          ? agentLogout(target.agentId, options)
          : authRun(target.agentId, method.id, options);
      },
      cancel: () =>
        invoke("auth_cancel", { agentId: target.agentId, attemptId }),
      end: () => invoke("auth_end", { agentId: target.agentId, attemptId }),
      reconnect,
    });
  }
  return activity;
}
