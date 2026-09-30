import { useEffect, useRef, useState, type RefObject } from "react";
import type { AgentsState } from "../runtime/agents";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { CUSTOM_AGENT } from "../runtime/custom_agent_strings";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";

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
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
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
  const valid = Boolean(
    name.trim() && command.trim() && !/[\r\n]/.test(command),
  );
  const close = () => {
    if (!pending.current) onClose();
  };
  return (
    <WorkspaceDialog
      title={CUSTOM_AGENT.title}
      onClose={close}
      returnFocusRef={returnFocusRef}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || pending.current) return;
          pending.current = true;
          setSubmitting(true);
          setAttempted(true);
          setError(null);
          void (async () => {
            try {
              const agentId = await agents.addCustom({
                name: name.trim(),
                command: command.trim(),
                args: args.split("\n").filter(Boolean),
              });
              if (alive.current && agentId) onAdded(agentId);
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
          <label>
            {CUSTOM_AGENT.name}
            <input
              value={name}
              disabled={submitting}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {CUSTOM_AGENT.command}
            <input
              value={command}
              disabled={submitting}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="/path/to/agent"
            />
          </label>
          <label>
            {CUSTOM_AGENT.args}
            <textarea
              rows={3}
              value={args}
              disabled={submitting}
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
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
    </WorkspaceDialog>
  );
}
