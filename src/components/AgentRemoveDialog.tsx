import { useState, type RefObject } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  agentLogout,
  type AgentCardModel,
  type AgentsState,
  type PtyChunk,
} from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { ProgramInventory } from "./ProgramManager";

/**
 * One removal flow for every Agent: Farfold's access is always removed
 * (credential grants revoked, registration dropped); each recorded
 * Farfold-managed installation may be deleted individually, and signing the
 * Agent account out is offered only while the live declaration supports it.
 * Programs Farfold never installed and Agent-owned account/configuration/
 * history are untouched; joined conversations stay in 所有对话 and the Agent
 * can be added again later.
 */
export function AgentRemoveDialog({
  card,
  agents,
  inventory,
  cwd,
  canLogout,
  blocked,
  onClose,
  onRemoved,
  returnFocusRef,
}: {
  card: AgentCardModel;
  agents: AgentsState;
  inventory: ProgramInventory;
  /** Exact directory of the live preparation connection; sign-out needs it. */
  cwd: string | null;
  /** True only while the Agent's current declaration supports official exit. */
  canLogout: boolean;
  /** Active work, pending items or unconfirmed operations block removal. */
  blocked: boolean;
  onClose: () => void;
  onRemoved: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Only receipts Farfold owns can be deleted; external programs never appear.
  const managed = inventory.items.filter((item) => item.managedRoot);
  const deletable = managed.filter((item) => item.canUninstall);
  const kept = managed.filter((item) => !item.canUninstall);
  const [uninstall, setUninstall] = useState<Set<string>>(new Set());
  const [signOut, setSignOut] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = blocked || working || !!agents.busy[card.id];

  const confirm = async () => {
    if (disabled) return;
    setWorking(true);
    setError(null);
    try {
      if (signOut && canLogout && cwd) {
        // The live connection is still needed for the exit request, so the
        // account step always runs before access removal ends connections.
        let unknown = false;
        const onOutput = new Channel<PtyChunk>();
        onOutput.onmessage = (chunk) => {
          if (chunk.authStatus === "unknown") unknown = true;
        };
        await agentLogout(card.id, {
          cwd,
          attemptId: crypto.randomUUID(),
          onOutput,
        });
        if (unknown) throw new Error(STRINGS.access.removeSignOutUnknown);
      }
      const outcome = await agents.remove(card.id, {
        uninstall: [...uninstall],
      });
      if (outcome?.removed) onRemoved();
    } catch (reason) {
      setError(uiError(reason, STRINGS.repair.requestFailed));
    } finally {
      setWorking(false);
    }
  };

  return (
    <WorkspaceDialog
      title={STRINGS.access.removeTitle(card.name)}
      busy={working}
      onClose={() => {
        if (!working) onClose();
      }}
      returnFocusRef={returnFocusRef}
    >
      <div className="workspace-dialog-body">
        <p>{STRINGS.access.removeHint}</p>
        <p>{STRINGS.access.removeHistoryNote}</p>
        {deletable.length > 0 && (
          <fieldset className="remove-agent-installs" disabled={disabled}>
            <legend>{STRINGS.access.removeUninstall}</legend>
            {deletable.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={uninstall.has(item.id)}
                  onChange={() =>
                    setUninstall((previous) => {
                      const next = new Set(previous);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })
                  }
                />
                <span>
                  {item.version ? `${item.version} · ` : ""}
                  {item.path}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {kept.map((item) => (
          <p className="auth-note" key={item.id}>
            {item.path} ·{" "}
            {item.inUse
              ? STRINGS.access.inUse
              : item.selected
                ? STRINGS.access.selected
                : STRINGS.access.removeInstallKept}
          </p>
        ))}
        {canLogout && cwd && (
          <label className="remove-agent-signout">
            <input
              type="checkbox"
              disabled={disabled}
              checked={signOut}
              onChange={(event) => setSignOut(event.target.checked)}
            />
            <span>{STRINGS.access.removeSignOut}</span>
          </label>
        )}
        {blocked && <p className="auth-note">{STRINGS.access.removeBusy}</p>}
        {error && (
          <p role="alert" className="workspace-error">
            {error}
          </p>
        )}
      </div>
      <footer>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={working}
          onClick={onClose}
        >
          {STRINGS.access.cancel}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={disabled}
          onClick={() => void confirm()}
        >
          {working ? STRINGS.common.loading : STRINGS.access.confirmRemove}
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
