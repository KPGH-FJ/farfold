import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  managedUpdateCheck,
  managedUpdateInstall,
  managedUpdateSnapshot,
  type ManagedUpdateSnapshot,
} from "../runtime/managed-update";
import { threads, useThreadsSnapshot } from "../runtime/sessions";
import {
  composerDrafts,
  draftPersistence,
  hasUnsentWork,
  unsentConversationKeys,
} from "../runtime/drafts";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
import {
  UPDATE_IMPACT as I,
  updateConversationBlocker,
  type UpdateConversationImpact,
} from "../runtime/update_impact";
import { WorkspaceDialog } from "./WorkspaceDialog";
import type { AgentCardModel } from "../runtime/agents";
import {
  authenticationActivity,
  useAuthenticationActivity,
} from "../runtime/authentication";
import { authActive } from "../runtime/auth_activity";

interface UpdateDialogProps {
  onClose: () => void;
  onOpenConversation?: (key: string) => void;
  agents?: AgentCardModel[];
  onOpenAgents?: (agentId?: string) => void;
}

interface UpdateInstallPorts {
  hasActiveWork: () => boolean;
  lockInteraction: (value: boolean) => void;
  pauseQueues: () => void;
  flush: () => Promise<void>;
  install: (token: string) => Promise<void>;
  readSnapshot: () => Promise<ManagedUpdateSnapshot>;
}
const installPorts: UpdateInstallPorts = {
  hasActiveWork: () =>
    [...threads.getSnapshot().threads.values()].some((thread) =>
      Boolean(updateConversationBlocker(thread)),
    ),
  lockInteraction: (value) => draftPersistence.lockInteraction(value),
  pauseQueues: () => threads.pauseQueuesForExit(),
  flush: () => draftPersistence.flush(),
  install: managedUpdateInstall,
  readSnapshot: managedUpdateSnapshot,
};

/** Keep the save barrier identical for installation and an installed candidate's
 * restart retry. Backend admission decides whether the token may install. */
export async function requestUpdateInstall(
  snapshot: ManagedUpdateSnapshot,
  ports: UpdateInstallPorts = installPorts,
): Promise<{ snapshot: ManagedUpdateSnapshot | null; error: string | null }> {
  const token = snapshot.candidate?.candidateToken;
  if (!token) return { snapshot, error: STRINGS.update.snapshotFailed };
  try {
    // Once this exact candidate is installed, backend admission remains closed.
    // A stale renderer work snapshot must not block its save/restart retry.
    if (!snapshot.restartPending && ports.hasActiveWork())
      throw new Error(STRINGS.update.workBlocked);
    ports.lockInteraction(true);
    ports.pauseQueues();
    await ports.flush();
    await ports.install(token);
    // This matching receipt means the candidate is installed and its save
    // event was requested. The restart itself still waits for DraftStartup.
    return {
      snapshot: { ...snapshot, installing: false, restartPending: true },
      error: null,
    };
  } catch (reason) {
    ports.lockInteraction(false);
    const current = await ports.readSnapshot().catch(() => null);
    return {
      snapshot: current,
      error: uiError(
        reason,
        current?.installing
          ? STRINGS.update.stillInstalling
          : current?.restartPending
            ? STRINGS.update.restartRetry
            : current
              ? STRINGS.update.installFailed
              : STRINGS.update.stateUnconfirmed,
      ),
    };
  }
}

function AccountImpact({
  agent,
  onChange,
  onOpen,
}: {
  agent: AgentCardModel;
  onChange: (id: string, active: boolean) => void;
  onOpen?: () => void;
}) {
  const activity = useAuthenticationActivity(agent.id);
  const active = authActive(activity);
  useEffect(() => {
    onChange(agent.id, active);
    return () => onChange(agent.id, false);
  }, [agent.id, active, onChange]);
  if (!active) return null;
  return (
    <div className="update-impact-row">
      <strong>{agent.name}</strong>
      <span>
        {activity?.phase === "unknown" ? I.accountUnknown : I.accounts}
      </span>
      {onOpen && (
        <button type="button" className="btn btn-text" onClick={onOpen}>
          {I.openAgents}
        </button>
      )}
    </div>
  );
}

export function UpdateDialog({
  onClose,
  onOpenConversation,
  agents = [],
  onOpenAgents,
}: UpdateDialogProps) {
  const live = useThreadsSnapshot();
  const saving = useSyncExternalStore(
    draftPersistence.subscribe,
    draftPersistence.snapshot,
    draftPersistence.snapshot,
  );
  const impacts: UpdateConversationImpact[] = [];
  const affected = new Set([
    ...live.threads.keys(),
    ...unsentConversationKeys(),
  ]);
  for (const key of affected) {
    const thread = live.threads.get(key);
    const blocker = thread ? updateConversationBlocker(thread) : null;
    const reason =
      blocker ??
      (thread?.queued.length
        ? I.queue
        : hasUnsentWork(key)
          ? I.savedDraft
          : null);
    if (reason)
      impacts.push({
        key,
        title:
          thread?.title ||
          live.index.find((row) => row.id === key)?.title ||
          I.untitled,
        reason,
        blocking: Boolean(blocker),
      });
  }
  const [snapshot, setSnapshot] = useState<ManagedUpdateSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [activeAccounts, setActiveAccounts] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const accountChanged = useCallback((id: string, active: boolean) => {
    setActiveAccounts((current) => {
      if (current.has(id) === active) return current;
      const next = new Set(current);
      if (active) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await run(async () => {
      try {
        setSnapshot(await managedUpdateSnapshot());
      } catch (reason) {
        setError(uiError(reason, STRINGS.update.snapshotFailed));
      }
    });
  }, [run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const check = async () => {
    await run(async () => {
      setSnapshot((current) =>
        current
          ? { ...current, checkStatus: "checking", candidate: null }
          : current,
      );
      try {
        setSnapshot(await managedUpdateCheck());
      } catch (reason) {
        setError(uiError(reason, STRINGS.update.checkFailed));
        const current = await managedUpdateSnapshot().catch(() => null);
        setSnapshot((previous) => {
          const latest = current ?? previous;
          if (!latest) return null;
          if (latest.restartPending) return latest;
          // An IPC error can precede admission; do not re-show an older
          // candidate as the result of this failed attempt.
          return {
            ...latest,
            checkStatus:
              latest.checkStatus === "checking" ? "checking" : "failed",
            candidate: null,
          };
        });
      }
    });
  };

  const install = async () => {
    if (!snapshot?.candidate) return;
    // Read the source again at the action boundary; the impact row's effect
    // may not have published its first render yet. Backend admission still
    // checks operations which this page cannot observe.
    if (
      !snapshot.restartPending &&
      agents.some((agent) =>
        authActive(authenticationActivity(agent.id).getSnapshot()),
      )
    ) {
      setError(I.accounts);
      return;
    }
    await run(async () => {
      const result = await requestUpdateInstall(snapshot);
      setSnapshot(result.snapshot);
      setError(result.error);
    });
  };

  return (
    <UpdateDialogContent
      snapshot={snapshot}
      pending={pending}
      error={error}
      onClose={onClose}
      onCheck={() => void check()}
      onInstall={() => void install()}
      onRefresh={() => void refresh()}
      impacts={impacts}
      saving={saving.saving}
      saveError={saving.error}
      onRetrySave={() => void draftPersistence.flush().catch(() => undefined)}
      onOpenConversation={
        onOpenConversation
          ? (key) => {
              onClose();
              onOpenConversation(key);
            }
          : undefined
      }
      accountBlocked={activeAccounts.size > 0}
      newDraft={
        composerDrafts.hasContent("new") ||
        Boolean(composerDrafts.read("new").pendingConversation)
      }
      accountImpacts={agents.map((agent) => (
        <AccountImpact
          key={agent.id}
          agent={agent}
          onChange={accountChanged}
          onOpen={
            onOpenAgents
              ? () => {
                  onClose();
                  onOpenAgents(agent.id);
                }
              : undefined
          }
        />
      ))}
    />
  );
}

export function UpdateDialogContent({
  snapshot,
  pending,
  error,
  onClose,
  onCheck,
  onInstall,
  onRefresh,
  impacts = [],
  saving = false,
  saveError = null,
  onRetrySave,
  onOpenConversation,
  accountBlocked = false,
  accountImpacts,
  newDraft = false,
}: {
  snapshot: ManagedUpdateSnapshot | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onRefresh: () => void;
  impacts?: UpdateConversationImpact[];
  saving?: boolean;
  saveError?: string | null;
  onRetrySave?: () => void;
  onOpenConversation?: (key: string) => void;
  accountBlocked?: boolean;
  accountImpacts?: import("react").ReactNode;
  newDraft?: boolean;
}) {
  const busy =
    pending ||
    !snapshot ||
    snapshot.checkStatus === "checking" ||
    snapshot.installing;
  const configured = snapshot?.configuration === "configured";
  const candidate =
    snapshot?.restartPending ||
    (configured && snapshot?.checkStatus === "available")
      ? snapshot.candidate
      : null;

  return (
    <WorkspaceDialog title={STRINGS.update.title} busy={busy} onClose={onClose}>
      <div className="workspace-dialog-body update-dialog-content">
        <div className="gen-row">
          <div>{STRINGS.update.currentVersion}</div>
          <span className="gv">{snapshot?.currentVersion ?? "…"}</span>
        </div>

        {snapshot?.blockers.includes("release_infrastructure_unconfigured") && (
          <div className="ac-error" role="status">
            {STRINGS.update.unconfigured}
          </div>
        )}
        {snapshot?.blockers.includes("release_infrastructure_invalid") && (
          <div className="ac-error" role="alert">
            {STRINGS.update.invalidConfig}
          </div>
        )}

        {candidate && (
          <div className="update-candidate">
            <div className="update-candidate-version">
              {STRINGS.update.candidate(candidate.version)}
            </div>
            {candidate.notes && (
              <div className="update-notes">{candidate.notes}</div>
            )}
            <div className="update-hint">
              {snapshot?.restartPending
                ? STRINGS.update.restartHint
                : STRINGS.update.installHint}
            </div>
            <section className="update-impact" aria-label={I.title}>
              <h3>{I.title}</h3>
              <p>{I.hint}</p>
              <p>
                {(accountBlocked || impacts.some((item) => item.blocking)) &&
                !snapshot?.restartPending
                  ? I.blocked
                  : I.noWork}
              </p>
              {impacts.map((item) => (
                <div key={item.key} className="update-impact-row">
                  <strong>{item.title}</strong>
                  <span>{item.reason}</span>
                  {onOpenConversation && !snapshot?.restartPending && (
                    <button
                      type="button"
                      className="btn btn-text"
                      onClick={() => onOpenConversation(item.key)}
                    >
                      {I.open}
                    </button>
                  )}
                </div>
              ))}
              {accountImpacts}
              {newDraft && <p>{I.newDraft}</p>}
              {saving && <p role="status">{I.saving}</p>}
              {saveError && (
                <div role="alert">
                  <p>{saveError}</p>
                  {onRetrySave && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={saving}
                      onClick={onRetrySave}
                    >
                      {I.retrySave}
                    </button>
                  )}
                </div>
              )}
              <p>{I.finalCheck}</p>
            </section>
            <div className="ac-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  (!snapshot?.restartPending &&
                    (accountBlocked || impacts.some((item) => item.blocking)))
                }
                onClick={onInstall}
              >
                {snapshot?.restartPending
                  ? STRINGS.update.restartPending
                  : snapshot?.installing
                    ? STRINGS.update.installing
                    : STRINGS.update.installAndRestart}
              </button>
            </div>
          </div>
        )}
        <div className="ac-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !configured || snapshot?.restartPending}
            onClick={onCheck}
          >
            {snapshot?.checkStatus === "checking"
              ? STRINGS.update.checking
              : STRINGS.update.check}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending}
            onClick={onRefresh}
          >
            {STRINGS.update.refresh}
          </button>
          {configured && snapshot?.checkStatus === "up_to_date" && (
            <span className="update-uptodate">{STRINGS.update.upToDate}</span>
          )}
          {configured && snapshot?.checkStatus === "not_checked" && (
            <span className="update-hint">{STRINGS.update.notChecked}</span>
          )}
          {snapshot?.checkStatus === "failed" && !error && (
            <span className="ac-error" role="alert">
              {STRINGS.update.checkFailed}
            </span>
          )}
        </div>

        {error && (
          <div className="ac-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </WorkspaceDialog>
  );
}
