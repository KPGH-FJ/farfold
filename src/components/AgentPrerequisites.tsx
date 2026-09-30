import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cancelDependencyInstall,
  getAgentPreparation,
  installAgentDependency,
  officialLink,
  type DependencyInstallMode,
  type PreparationInfo,
} from "../runtime/preparation";
import { PREPARATION_STRINGS as S } from "../runtime/preparation_strings";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";

export function AgentPrerequisites({
  agentId,
  refreshKey,
  onChange,
  onInstallReadyChange,
  onBusyChange,
  onBeforeInstall,
  onInstalled,
}: {
  agentId: string;
  refreshKey?: string | number;
  onChange: (ready: boolean) => void;
  onInstallReadyChange?: (ready: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onBeforeInstall?: () => Promise<void>;
  onInstalled?: () => Promise<void>;
}) {
  const [info, setInfo] = useState<PreparationInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const installing = useRef<{
    agentId: string;
    ticket: number;
    cancelled: boolean;
  } | null>(null);
  const callbacks = useRef({ onChange, onInstallReadyChange, onBusyChange });
  callbacks.current = { onChange, onInstallReadyChange, onBusyChange };
  const updateReadiness = (result: PreparationInfo) => {
    callbacks.current.onChange(
      result.dependencies
        .filter((item) => item.requiredForUse !== false)
        .every((item) => item.status === "ready"),
    );
    callbacks.current.onInstallReadyChange?.(
      result.dependencies
        .filter((item) => item.requiredForInstall)
        .every((item) => item.status === "ready"),
    );
  };

  useEffect(() => {
    setBusy(false);
    setCancelling(false);
    return () => {
      generation.current++;
      if (installing.current?.agentId === agentId)
        void cancelDependencyInstall(agentId).catch(() => undefined);
      installing.current = null;
      callbacks.current.onBusyChange?.(false);
    };
  }, [agentId]);

  useEffect(() => {
    // A program-list refresh must not detach the owner of an active install.
    if (installing.current?.agentId === agentId) return;
    const ticket = ++generation.current;
    setInfo(null);
    setError(null);
    setNotice(null);
    callbacks.current.onChange(false);
    callbacks.current.onInstallReadyChange?.(false);
    void getAgentPreparation(agentId, reload > 0)
      .then((result) => {
        if (ticket !== generation.current) return;
        setInfo(result);
        updateReadiness(result);
      })
      .catch((reason) => {
        if (ticket === generation.current)
          setError(uiError(reason, S.checkFailed));
      });
    return () => {
      generation.current++;
    };
  }, [agentId, refreshKey, reload]);

  const install = async (
    dependencyId: string,
    mode: DependencyInstallMode = "install_missing",
  ) => {
    const dependency = info?.dependencies.find(
      (item) => item.id === dependencyId,
    );
    if (
      !dependency ||
      (mode === "prepare_candidate"
        ? !dependency.canInstallCandidate
        : !dependency.installable || dependency.status === "ready") ||
      installing.current
    )
      return;
    const ticket = ++generation.current;
    const operation = { agentId, ticket, cancelled: false };
    installing.current = operation;
    setBusy(true);
    setCancelling(false);
    setError(null);
    setNotice(null);
    setStage(null);
    callbacks.current.onBusyChange?.(true);
    try {
      if (mode === "install_missing" && dependency.requiredForUse !== false)
        await onBeforeInstall?.();
      if (installing.current !== operation || operation.cancelled) return;
      const result = await installAgentDependency(
        agentId,
        dependencyId,
        (p) => {
          if (ticket === generation.current) {
            setStage(
              mode === "prepare_candidate" && p.stage === "ready"
                ? S.candidateInstalled
                : mode === "prepare_candidate" && p.stage === "check"
                  ? S.candidateChecking
                  : (S.installStages[p.stage] ??
                    STRINGS.install.stages[p.stage] ??
                    S.installing),
            );
          }
        },
        mode,
      );
      if (ticket !== generation.current) return;
      setInfo(result);
      updateReadiness(result);
      if (mode === "prepare_candidate") setNotice(S.candidateInstalled);
      try {
        await onInstalled?.();
      } catch (reason) {
        if (ticket === generation.current)
          setError(uiError(reason, S.refreshProgramsFailed));
      }
    } catch (reason) {
      if (ticket === generation.current)
        setError(uiError(reason, S.installFailed));
    } finally {
      if (installing.current === operation) {
        installing.current = null;
        setBusy(false);
        setCancelling(false);
        callbacks.current.onBusyChange?.(false);
        if (ticket !== generation.current) setReload((value) => value + 1);
      }
    }
  };

  const cancel = async () => {
    if (!installing.current || cancelling) return;
    installing.current.cancelled = true;
    setCancelling(true);
    try {
      await cancelDependencyInstall(agentId);
      // The install result owns completion; a sent cancellation is not completion.
    } catch (reason) {
      setCancelling(false);
      setError(uiError(reason, S.cancelFailed));
    }
  };

  if (info?.dependencies.length === 0 && !error) return null;
  return (
    <section
      className="agent-preparation-dependencies"
      aria-label={S.dependencies}
    >
      <h4>{S.dependencies}</h4>
      {!info && !error && <p role="status">{S.loading}</p>}
      {info?.dependencies.map((item) => (
        <div className="agent-setup-program" key={item.id}>
          <div>
            <strong>{item.name}</strong>
            <p>{S[item.status]}</p>
            {item.detail && <p>{item.detail}</p>}
            {(item.programVersion != null ||
              item.componentVersion != null ||
              item.versionRequirement ||
              item.canInstallCandidate) && (
              <>
                <p>
                  {S.programVersion}：{item.programVersion ?? S.unknownVersion}
                </p>
                <p>
                  {S.componentVersion}：
                  {item.componentVersion ?? S.unknownVersion}
                </p>
                {item.versionRequirement ? (
                  <>
                    <p>
                      {S.officialRequirement}：{item.versionRequirement.range}
                    </p>
                    <p>{S.versionStates[item.versionRequirement.state]}</p>
                    {officialLink(item.versionRequirement.sourceUrl) && (
                      <button
                        className="btn btn-text"
                        onClick={() =>
                          void openUrl(
                            item.versionRequirement!.sourceUrl,
                          ).catch((reason) =>
                            setError(uiError(reason, S.openFailed)),
                          )
                        }
                      >
                        {S.requirementSource}
                      </button>
                    )}
                  </>
                ) : (
                  <p>{S.requirementUnknown}</p>
                )}
                {item.status === "ready" && <p>{S.versionTry}</p>}
              </>
            )}
            {officialLink(item.sourceUrl) && (
              <button
                className="btn btn-text"
                onClick={() =>
                  void openUrl(item.sourceUrl).catch((reason) =>
                    setError(uiError(reason, S.openFailed)),
                  )
                }
              >
                {S.source} · {new URL(item.sourceUrl).hostname}
              </button>
            )}
            {item.status !== "ready" && (
              <details>
                <summary>{S.details}</summary>
                <p>
                  {S.location}：{item.managedLocation}
                </p>
                <p>
                  {S.command}：{item.checkCommand}
                </p>
                <p>{S.scope}</p>
              </details>
            )}
            {item.canInstallCandidate && (
              <p className="auth-note">{S.candidateScope}</p>
            )}
          </div>
          {item.status !== "ready" && item.installable && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void install(item.id)}
            >
              {busy ? S.installing : S.install}
            </button>
          )}
          {item.canInstallCandidate && (
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void install(item.id, "prepare_candidate")}
            >
              {S.installCandidate}
            </button>
          )}
        </div>
      ))}
      {busy && (
        <div className="agent-setup-progress" role="status">
          <span>{stage ?? S.installing}</span>
          <button
            className="btn btn-text"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? S.cancelling : S.cancel}
          </button>
        </div>
      )}
      {error && (
        <p className="ac-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="auth-note" role="status">
          {notice}
        </p>
      )}
      {!busy && (error || info?.dependencies.length) && (
        <button
          className="btn btn-ghost"
          onClick={() => setReload((value) => value + 1)}
        >
          {S.retry}
        </button>
      )}
    </section>
  );
}
