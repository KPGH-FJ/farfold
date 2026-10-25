import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { threads, type ThreadState } from "../runtime/sessions";
import type { AgentConnectionStatus } from "../runtime/agents";
import { authenticationActivity } from "../runtime/authentication";
import { configChangeBusy } from "../runtime/protected_config";
import { hasIdentityReadOwner } from "../runtime/session_identity";
import { identityReadSupport } from "../runtime/session_identity_types";
import { CONNECTION_ACCOUNT_STRINGS } from "../runtime/connection_account_strings";

const S = CONNECTION_ACCOUNT_STRINGS.currentIdentity;
const ownerScope = (s: ThreadState) =>
  JSON.stringify([
    s.key,
    s.agentId,
    s.cwd,
    s.nativeSessionId,
    s.connectionId,
    s.serviceContext ?? null,
    s.service?.id ?? null,
    s.service?.fingerprint ?? null,
  ]);

/** An explicit supplement for this actual owner; no authentication or plan update. */
export function SessionIdentityControl({
  thread,
  active,
}: {
  thread: ThreadState;
  active: boolean;
}) {
  const latest = useRef({ thread, active });
  latest.current = { thread, active };
  const mounted = useRef(false);
  const key = thread.key;
  const scope = ownerScope(thread);
  const sameOwner = () =>
    threads.thread(key) === thread && ownerScope(thread) === scope;
  const clear = () => {
    if (sameOwner()) threads.clearIdentity(key, thread);
  };
  const current = () => {
    const value = latest.current;
    return mounted.current &&
      value.active &&
      value.thread === thread &&
      sameOwner()
      ? value.thread
      : undefined;
  };
  useSyncExternalStore(
    threads.subscribe,
    threads.getSnapshot,
    threads.getSnapshot,
  );
  useLayoutEffect(() => {
    if (!active) return;
    mounted.current = true;
    const { agentId, cwd, connectionId } = thread;
    const auth = authenticationActivity(thread.agentId);
    let previousAuth = auth.getSnapshot();
    const offAuth = auth.subscribe(() => {
      const next = auth.getSnapshot();
      if (next !== previousAuth) {
        previousAuth = next;
        clear();
      }
    });
    let disposed = false;
    let offStatus: (() => void) | undefined;
    void listen<AgentConnectionStatus>("agent:status", ({ payload }) => {
      if (
        !disposed &&
        payload.agentId === agentId &&
        payload.cwd === cwd &&
        payload.connectionId === connectionId
      )
        clear();
    })
      .then((off) => {
        if (disposed) off();
        else offStatus = off;
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      disposed = true;
      offAuth();
      offStatus?.();
      clear();
    };
  }, [thread, scope, active]);
  if (
    !active ||
    threads.thread(thread.key) !== thread ||
    !hasIdentityReadOwner(thread)
  )
    return null;
  const available = identityReadSupport(thread.identityRead);
  const slot = thread.sessionIdentityRead;
  if (!available && !slot) return null;
  const busy = configChangeBusy(thread);
  const identity = slot?.phase === "reported" ? slot.identity : null;
  return (
    <section className="journey-connection-summary" aria-label={S.title}>
      {available && (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || slot?.phase === "loading"}
          title={busy ? S.errors.busy : undefined}
          onClick={() => void threads.readIdentity(thread.key, current)}
        >
          {S.read}
        </button>
      )}
      {slot?.phase === "loading" && <p role="status">{S.reading}</p>}
      {slot?.phase === "error" && <p role="alert">{S.errors[slot.code]}</p>}
      {slot?.phase === "reported" && (
        <div role="status">
          <strong>
            {[
              ...new Set(
                [identity?.email, identity?.displayName].filter(Boolean),
              ),
            ].join(" · ") || S.notProvided}
          </strong>
          {identity?.workspaceName && (
            <p>
              {S.workspace}：{identity.workspaceName}
            </p>
          )}
          {identity?.organizationName && (
            <p>
              {S.organization}：{identity.organizationName}
            </p>
          )}
        </div>
      )}
      <details className="agent-evidence-details">
        <summary>{S.title}</summary>
        <p className="auth-note">{S.scope}</p>
      </details>
    </section>
  );
}
