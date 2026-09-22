import { uiError } from "../runtime/ui_error";
import { Fragment } from "react";
import { ManualAuthSection } from "./ManualAuthSection";
import { Channel } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import {
  agentLogout,
  authMethods,
  authRun,
  authSetApiKey,
  type AuthMethodInfo,
  type AuthMethodsResponse,
  type PtyChunk,
} from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { InlineTerminal } from "./InlineTerminal";

export interface AgentAuthSectionProps {
  agentId: string;
  /** Re-pull agent state after a login/logout round-trip. */
  onChanged: () => Promise<void>;
  /** Disconnect + connect so the next spawn picks up new credentials. */
  onReconnect: () => Promise<void>;
}

const AUTH_STRINGS = STRINGS.agents.auth;

function MethodRow({
  agentId,
  method,
  busy,
  note,
  terminalOpen,
  onStart,
  onTerminal,
  onTerminalExit,
}: {
  agentId: string;
  method: AuthMethodInfo;
  busy: boolean;
  note: string | null;
  terminalOpen: boolean;
  onStart: () => void;
  onTerminal: () => void;
  onTerminalExit: (code: number) => void;
}) {
  const startTerminal = useCallback(
    (onOutput: Channel<PtyChunk>) =>
      authRun(agentId, method.id, {
        viaTerminal: true,
        onOutput,
      }).then((result) => result.ptyId ?? ""),
    [agentId, method.id],
  );
  return (
    <div className="auth-row">
      <div>
        <div className="auth-name">{method.name}</div>
        {method.description && (
          <div className="auth-desc">{method.description}</div>
        )}
      </div>
      <div className="auth-side">
        {method.kind === "agent" && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={onStart}
          >
            {busy ? AUTH_STRINGS.starting : AUTH_STRINGS.start}
          </button>
        )}
        {(method.kind === "terminal" || method.terminalCommand) && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={onTerminal}
          >
            {terminalOpen ? AUTH_STRINGS.collapsed : AUTH_STRINGS.terminal}
          </button>
        )}
      </div>
      {note && <div className="auth-note">{note}</div>}
      {terminalOpen && (
        <InlineTerminal start={startTerminal} onExit={onTerminalExit} />
      )}
    </div>
  );
}

function ApiKeyRow({
  method,
  busy,
  note,
  onSave,
}: {
  method: AuthMethodInfo;
  busy: boolean;
  note: string | null;
  onSave: (envName: string, key: string) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  const [customEnv, setCustomEnv] = useState("");
  const envName = method.envName ?? customEnv;
  return (
    <div className="auth-row">
      <div>
        <div className="auth-name">{method.name}</div>
        {method.description && (
          <div className="auth-desc">{method.description}</div>
        )}
      </div>
      {!method.envName && (
        <input
          className="custom-input"
          aria-label={STRINGS.repair.envName}
          placeholder={STRINGS.repair.envName}
          value={customEnv}
          onChange={(event) => setCustomEnv(event.target.value)}
        />
      )}
      <div className="auth-keyline">
        <input
          className="custom-input auth-key"
          type="password"
          value={key}
          placeholder={AUTH_STRINGS.apiKeyPlaceholder}
          spellCheck={false}
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={
            busy || !key.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)
          }
          onClick={() =>
            void onSave(envName, key).then((ok) => {
              if (ok) setKey("");
            })
          }
        >
          {busy ? AUTH_STRINGS.saving : STRINGS.repair.saveKey}
        </button>
      </div>
      {envName && (
        <div className="auth-note">{AUTH_STRINGS.apiKeyEnv(envName)}</div>
      )}
      {note && <div className="auth-note">{note}</div>}
    </div>
  );
}

/**
 * The「登录」block on a connected agent card: renders whatever the agent
 * advertised through authMethods — agent-type buttons, embedded-terminal
 * entries, api-key capture — plus logout when supported.
 */
export function AgentAuthSection({
  agentId,
  onChanged,
  onReconnect,
}: AgentAuthSectionProps) {
  const [info, setInfo] = useState<AuthMethodsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [terminalFor, setTerminalFor] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authMethods(agentId)
      .then((response) => {
        if (!cancelled) setInfo(response);
      })
      .catch((reason) => {
        if (!cancelled) setError(uiError(reason, AUTH_STRINGS.failed));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const setNote = useCallback((methodId: string, note: string | null) => {
    setNotes((prev) => {
      const next = { ...prev };
      if (note === null) delete next[methodId];
      else next[methodId] = note;
      return next;
    });
  }, []);

  const runAgent = async (method: AuthMethodInfo) => {
    setBusyId(method.id);
    setNote(method.id, AUTH_STRINGS.browserHint);
    try {
      await authRun(agentId, method.id, {
        onOutput: new Channel<PtyChunk>(),
      });
      setNote(method.id, null);
      await onChanged();
    } catch (reason) {
      setNote(method.id, uiError(reason, AUTH_STRINGS.failed));
    } finally {
      setBusyId(null);
    }
  };

  const runApiKey = async (envName: string, key: string) => {
    setBusyId("api-key");
    try {
      await authSetApiKey(agentId, envName, key);
      setNote("api-key", STRINGS.credentials.reconnectHint);
      await onChanged();
      return true;
    } catch (reason) {
      setNote("api-key", STRINGS.credentials.failed);
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const onTerminalExit = async (code: number) => {
    setTerminalFor(null);
    if (code === 0 && terminalFor)
      setNote(terminalFor, STRINGS.credentials.terminalFinished);
    await onChanged();
  };

  const logout = async () => {
    setLoggingOut(true);
    try {
      await agentLogout(agentId);
      await onChanged();
    } catch (reason) {
      setError(uiError(reason, AUTH_STRINGS.failed));
    } finally {
      setLoggingOut(false);
    }
  };

  if (error) {
    return (
      <div className="auth">
        <div className="s-sec-label">{AUTH_STRINGS.heading}</div>
        <div className="ac-error auth-error" role="alert">
          {error}
        </div>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="auth">
        <div className="s-sec-label">{AUTH_STRINGS.heading}</div>
        <div className="auth-note">{AUTH_STRINGS.loading}</div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="s-sec-label">{AUTH_STRINGS.heading}</div>
      <div className="auth-note">
        {STRINGS.credentials.reconnectAdvice}
        <button
          type="button"
          className="btn btn-text"
          disabled={busyId !== null || loggingOut}
          onClick={() => void onReconnect()}
        >
          {STRINGS.thread.reconnect}
        </button>
      </div>
      {info.methods.length === 0 && (
        <div className="auth-note">{AUTH_STRINGS.none}</div>
      )}
      {info.methods.map((method) => (
        <Fragment key={method.id}>
          {method.kind === "api-key" ? (
            <ApiKeyRow
              key={method.id}
              method={method}
              busy={busyId === method.id || busyId === "api-key"}
              note={notes[method.id] ?? notes["api-key"] ?? null}
              onSave={runApiKey}
            />
          ) : (
            <MethodRow
              key={method.id}
              agentId={agentId}
              method={method}
              busy={busyId === method.id}
              note={notes[method.id] ?? null}
              terminalOpen={terminalFor === method.id}
              onStart={() => void runAgent(method)}
              onTerminal={() =>
                setTerminalFor((prev) =>
                  prev === method.id ? null : method.id,
                )
              }
              onTerminalExit={(code) => void onTerminalExit(code)}
            />
          )}
          <ManualAuthSection
            agentId={agentId}
            methodId={method.id}
            declaredEnv={method.envName}
            onChanged={onChanged}
          />
        </Fragment>
      ))}
      {info.methods.length === 0 && (
        <ManualAuthSection
          agentId={agentId}
          methodId="manual"
          onChanged={onChanged}
        />
      )}
      {info.canLogout && (
        <div className="auth-actions">
          <button
            type="button"
            className="btn btn-text"
            disabled={loggingOut}
            onClick={() => void logout()}
          >
            {loggingOut ? AUTH_STRINGS.loggingOut : AUTH_STRINGS.logout}
          </button>
        </div>
      )}
    </div>
  );
}
