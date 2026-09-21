import { useCallback, useEffect, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { authSetApiKey, type PtyChunk } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { InlineTerminal } from "./InlineTerminal";
interface Config {
  command: string;
  args: string[];
  envName: string | null;
}
export function ManualAuthSection({
  agentId,
  methodId,
  declaredEnv,
  onChanged,
}: {
  agentId: string;
  methodId: string;
  declaredEnv?: string | null;
  onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [saved, setSaved] = useState<Config | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let active = true;
    void invoke<Config | null>("auth_manual_get", { agentId, methodId })
      .then((value) => {
        if (active) {
          setSaved(value);
          setCommand(value?.command ?? "");
          setArgs(value?.args.join("\n") ?? "");
          setEnv(value?.envName ?? "");
        }
      })
      .catch(() => {
        if (active) setNote(STRINGS.repair.authFailed);
      });
    return () => {
      active = false;
    };
  }, [agentId, methodId]);
  const save = async (clear = false) => {
    setBusy(true);
    setNote(null);
    const config: Config | null = clear
      ? null
      : {
          command: command.trim(),
          args: args.split("\n").filter((arg) => arg.length > 0),
          envName: declaredEnv || env.trim() || null,
        };
    try {
      await invoke("auth_manual_set", { agentId, methodId, config });
      setSaved(config);
      if (clear) {
        setCommand("");
        setArgs("");
        setEnv("");
        setSecret("");
      }
      setNote(STRINGS.repair.manualSaved);
    } catch {
      setNote(STRINGS.repair.authFailed);
    } finally {
      setBusy(false);
    }
  };
  const start = useCallback(
    (onOutput: Channel<PtyChunk>) =>
      invoke<string>("auth_manual_run", { agentId, methodId, onOutput }),
    [agentId, methodId],
  );
  const saveKey = async () => {
    const envName = declaredEnv || env.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      setNote(STRINGS.repair.invalidEnv);
      return;
    }
    setBusy(true);
    try {
      await authSetApiKey(agentId, envName, secret);
      setSecret("");
      setNote(STRINGS.repair.keySaved);
      await onChanged();
    } catch {
      setNote(STRINGS.repair.authFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <button
        type="button"
        className="btn btn-text"
        onClick={() => setExpanded((v) => !v)}
      >
        {STRINGS.repair.manualAuth}
      </button>
      {expanded && (
        <>
          <label className="auth-note">
            {STRINGS.repair.executable}
            <input
              className="custom-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={busy || running}
            />
          </label>
          <label className="auth-note">
            {STRINGS.repair.arguments}
            <textarea
              className="custom-input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              disabled={busy || running}
            />
          </label>
          <label className="auth-note">
            {STRINGS.repair.envName}
            <input
              className="custom-input"
              value={declaredEnv || env}
              readOnly={!!declaredEnv}
              onChange={(e) => setEnv(e.target.value)}
              disabled={busy || running}
            />
          </label>
          <div className="auth-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || running}
              onClick={() => void save()}
            >
              {STRINGS.repair.save}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || running || !saved}
              onClick={() => void save(true)}
            >
              {STRINGS.repair.clear}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || running || !saved?.command}
              onClick={() => setRunning(true)}
            >
              {STRINGS.repair.run}
            </button>
          </div>
          {(declaredEnv || env) && (
            <div className="auth-keyline">
              <input
                type="password"
                className="custom-input"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={STRINGS.agents.auth.apiKeyPlaceholder}
              />
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy || !secret}
                onClick={() => void saveKey()}
              >
                {STRINGS.repair.saveKey}
              </button>
            </div>
          )}
        </>
      )}
      {note && (
        <div className="auth-note" role="status">
          {note}
        </div>
      )}
      {running && (
        <InlineTerminal
          start={start}
          onExit={() => {
            setRunning(false);
            void onChanged();
          }}
        />
      )}
    </div>
  );
}
