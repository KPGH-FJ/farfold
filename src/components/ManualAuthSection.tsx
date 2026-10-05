import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STRINGS } from "../runtime/strings";
import { PREPARATION_STRINGS } from "../runtime/preparation_strings";
interface Config {
  command: string;
  args: string[];
  envName: string | null;
}
export function ManualAuthSection({
  agentId,
  methodId,
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
  const [saved, setSaved] = useState<Config | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setReadFailed(false);
    setSaved(null);
    setCommand("");
    setArgs("");
    setNote(null);
    void invoke<Config | null>("auth_manual_get", { agentId, methodId })
      .then((value) => {
        if (active) {
          setSaved(value);
          setCommand(value?.command ?? "");
          setArgs(value?.args.join("\n") ?? "");
          setLoaded(true);
          if (value && !value.command.trim())
            setNote(STRINGS.repair.executableRequired);
        }
      })
      .catch(() => {
        if (active) {
          setReadFailed(true);
          setNote(STRINGS.repair.authFailed);
        }
      });
    return () => {
      active = false;
      attempt.current++;
    };
  }, [agentId, methodId, reload]);
  const unavailable = disabled || busy || !loaded;
  const normalizedCommand = command.trim();
  const normalizedArgs = args.split("\n").filter((arg) => arg.length > 0);
  const runnable =
    !unavailable &&
    !!normalizedCommand &&
    !!saved &&
    normalizedCommand === saved.command &&
    normalizedArgs.length === saved.args.length &&
    normalizedArgs.every((arg, index) => arg === saved.args[index]);
  const save = async (clear = false) => {
    if (unavailable) return;
    if (!clear && !normalizedCommand) {
      setNote(STRINGS.repair.executableRequired);
      return;
    }
    const release = onAcquire();
    if (!release) return;
    const ticket = ++attempt.current;
    onInvalidate?.();
    setBusy(true);
    setNote(null);
    const config: Config | null = clear
      ? null
      : {
          command: normalizedCommand,
          args: normalizedArgs,
          envName: saved?.envName ?? null,
        };
    try {
      await invoke("auth_manual_set", { agentId, methodId, config });
      if (ticket !== attempt.current) return;
      setSaved(config);
      if (clear) {
        setCommand("");
        setArgs("");
      }
      setNote(STRINGS.repair.manualSaved);
    } catch {
      if (ticket === attempt.current) setNote(STRINGS.repair.authFailed);
    } finally {
      release();
      if (ticket === attempt.current) setBusy(false);
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
              placeholder={STRINGS.repair.executableRequired}
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
          <div className="auth-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={unavailable || !normalizedCommand}
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
              disabled={!runnable}
              onClick={() => {
                if (runnable) onRun();
              }}
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
      {readFailed && (
        <button
          type="button"
          className="btn btn-text"
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setReadFailed(false);
            setReload((value) => value + 1);
          }}
        >
          {PREPARATION_STRINGS.retry}
        </button>
      )}
    </div>
  );
}
