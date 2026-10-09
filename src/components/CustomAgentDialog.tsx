import { useEffect, useRef, useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentsState } from "../runtime/agents";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { CUSTOM_AGENT } from "../runtime/custom_agent_strings";
import { STRINGS } from "../runtime/strings";
import { AGENT_REDESIGN as U } from "../runtime/agent_redesign_strings";
import {
  customAgentDraft,
  hasCustomAgentDraft,
} from "../runtime/custom_agent_draft";
import "../agent-redesign.css";
import { uiError } from "../runtime/ui_error";

/** `NAME=value` per line; empty lines are ignored. Values may contain `=`. */
export function parseEnvLines(text: string): {
  env: Record<string, string>;
  error: string | null;
} {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return { env: {}, error: CUSTOM_AGENT.envMissingName };
    const name = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return { env: {}, error: CUSTOM_AGENT.envInvalid };
    if (name in env) return { env: {}, error: CUSTOM_AGENT.envDuplicate(name) };
    env[name] = trimmed.slice(eq + 1);
  }
  return { env, error: null };
}

export function CustomAgentDialog({
  agents,
  onClose,
  onAdded,
  returnFocusRef,
}: {
  agents: AgentsState;
  onClose: () => void;
  onAdded: (agentId: string) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const retained = customAgentDraft.read();
  const [name, setName] = useState(retained?.name ?? "");
  const [command, setCommand] = useState(retained?.command ?? "");
  const [args, setArgs] = useState(retained?.args ?? "");
  const [envText, setEnvText] = useState(retained?.envText ?? "");
  const [confirmExit, setConfirmExit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const nameError = !name.trim() ? CUSTOM_AGENT.nameRequired : null;
  const commandError = !command.trim()
    ? CUSTOM_AGENT.commandRequired
    : /[\r\n]/.test(command)
      ? CUSTOM_AGENT.commandInvalid
      : null;
  const parsed = parseEnvLines(envText);
  const valid = !nameError && !commandError && !parsed.error;
  const close = () => {
    if (pending.current) return;
    if (hasCustomAgentDraft({ name, command, args, envText }))
      setConfirmExit(true);
    else {
      customAgentDraft.clear();
      onClose();
    }
  };
  const pickFile = async () => {
    try {
      const path = await open({ directory: false, multiple: false });
      if (typeof path === "string") setCommand(path);
    } catch (reason) {
      setError(uiError(reason, STRINGS.repair.requestFailed));
    }
  };
  return (
    <WorkspaceDialog
      title={CUSTOM_AGENT.title}
      busy={submitting}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      {confirmExit ? (
        <div className="agent-custom-layout agent-custom-exit">
          <div className="workspace-dialog-body">
            <h3>{U.customUnsaved}</h3>
            <p>{U.customUnsavedHint}</p>
          </div>
          <footer className="agent-custom-exit-actions">
            <button
              className="btn btn-ghost"
              onClick={() => {
                customAgentDraft.clear();
                onClose();
              }}
            >
              {U.customDiscard}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                customAgentDraft.keep({ name, command, args, envText });
                onClose();
              }}
            >
              {U.customKeep}
            </button>
            <button
              autoFocus
              className="btn btn-primary"
              onClick={() => setConfirmExit(false)}
            >
              {U.customContinue}
            </button>
          </footer>
        </div>
      ) : (
        <form
          className="agent-custom-layout agent-custom-form"
          onSubmit={(event) => {
            event.preventDefault();
            setAttempted(true);
            if (!valid || pending.current || confirmExit) return;
            pending.current = true;
            setSubmitting(true);
            setError(null);
            void (async () => {
              try {
                const agentId = await agents.addCustom({
                  name: name.trim(),
                  command: command.trim(),
                  args: args.split("\n").filter(Boolean),
                  env: parsed.env,
                });
                if (alive.current && agentId) {
                  customAgentDraft.clear();
                  onAdded(agentId);
                }
              } catch (reason) {
                if (alive.current)
                  setError(uiError(reason, STRINGS.repair.requestFailed));
              } finally {
                pending.current = false;
                if (alive.current) setSubmitting(false);
              }
            })();
          }}
        >
          <div className="workspace-dialog-body custom-agent-fields">
            <p>{CUSTOM_AGENT.description}</p>
            {retained && (
              <p className="auth-note" role="status">
                {U.customRestored}
              </p>
            )}
            <label>
              {CUSTOM_AGENT.name}
              <input
                value={name}
                disabled={submitting}
                aria-invalid={attempted && !!nameError}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {attempted && nameError && (
              <p role="alert" className="workspace-error">
                {nameError}
              </p>
            )}
            <label>
              {CUSTOM_AGENT.command}
              <input
                value={command}
                disabled={submitting}
                aria-invalid={attempted && !!commandError}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="/path/to/agent"
              />
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={() => void pickFile()}
            >
              {CUSTOM_AGENT.chooseFile}
            </button>
            {attempted && commandError && (
              <p role="alert" className="workspace-error">
                {commandError}
              </p>
            )}
            <label>
              {CUSTOM_AGENT.args}
              <textarea
                rows={3}
                value={args}
                disabled={submitting}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
            <p className="auth-note">{CUSTOM_AGENT.argsHint}</p>
            <label>
              {CUSTOM_AGENT.env}
              <textarea
                rows={3}
                value={envText}
                disabled={submitting}
                aria-invalid={attempted && !!parsed.error}
                placeholder={"NAME=value"}
                onChange={(e) => setEnvText(e.target.value)}
              />
            </label>
            <p className="auth-note">{CUSTOM_AGENT.envHint}</p>
            {attempted && parsed.error && (
              <p role="alert" className="workspace-error">
                {parsed.error}
              </p>
            )}
            {attempted && (error || agents.errors.__custom) && (
              <p role="alert" className="workspace-error">
                {error || agents.errors.__custom}
              </p>
            )}
          </div>
          <footer>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              onClick={close}
            >
              {CUSTOM_AGENT.cancel}
            </button>
            <button className="btn btn-primary" disabled={!valid || submitting}>
              {submitting ? CUSTOM_AGENT.adding : CUSTOM_AGENT.add}
            </button>
          </footer>
        </form>
      )}
    </WorkspaceDialog>
  );
}
