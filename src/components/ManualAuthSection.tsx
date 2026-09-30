import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STRINGS } from "../runtime/strings";
interface Config {
  command: string;
  args: string[];
  envName: string | null;
}
export function ManualAuthSection({
  agentId,
  methodId,
  declaredEnv,
  disabled = false,
  onAcquire,
  onInvalidate,
  onRun,
}: {
  agentId: string;
  methodId: string;
  declaredEnv?: string | null;
  disabled?: boolean;
  onAcquire: () => (() => void) | null;
  onInvalidate?: () => void;
  onRun: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [saved, setSaved] = useState<Config | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const attempt = useRef(0);
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
      attempt.current++;
    };
  }, [agentId, methodId]);
  const save = async (clear = false) => {
    const release = onAcquire();
    if (!release) return;
    const ticket = ++attempt.current;
    onInvalidate?.();
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
      if (ticket !== attempt.current) return;
      setSaved(config);
      if (clear) {
        setCommand("");
        setArgs("");
        setEnv("");
      }
      setNote(STRINGS.repair.manualSaved);
    } catch {
      if (ticket === attempt.current) setNote(STRINGS.repair.authFailed);
    } finally {
      release();
      if (ticket === attempt.current) setBusy(false);
    }
  };
  const unavailable = disabled || busy;
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
              disabled={unavailable}
            />
          </label>
          <label className="auth-note">
            {STRINGS.repair.arguments}
            <textarea
              className="custom-input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              disabled={unavailable}
            />
          </label>
          <label className="auth-note">
            {STRINGS.repair.envName}
            <input
              className="custom-input"
              value={declaredEnv || env}
              readOnly={!!declaredEnv}
              onChange={(e) => setEnv(e.target.value)}
              disabled={unavailable}
            />
          </label>
          <div className="auth-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={unavailable}
              onClick={() => void save()}
            >
              {STRINGS.repair.save}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={unavailable || !saved}
              onClick={() => void save(true)}
            >
              {STRINGS.repair.clear}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={unavailable || !saved?.command}
              onClick={onRun}
            >
              {STRINGS.repair.run}
            </button>
          </div>
        </>
      )}
      {note && (
        <div className="auth-note" role="status">
          {note}
        </div>
      )}
    </div>
  );
}
