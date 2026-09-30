import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cancelDependencyInstall,
  getAgentPreparation,
  installAgentDependency,
  officialLink,
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
    callbacks.current.onChange(false);
    callbacks.current.onInstallReadyChange?.(false);
    void getAgentPreparation(agentId)
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

  const install = async (dependencyId: string) => {
    const dependency = info?.dependencies.find(
      (item) => item.id === dependencyId,
    );
    if (
      !dependency ||
      !dependency.installable ||
      dependency.status === "ready" ||
      installing.current
    )
      return;
    const ticket = ++generation.current;
    const operation = { agentId, ticket, cancelled: false };
    installing.current = operation;
    setBusy(true);
    setCancelling(false);
    setError(null);
    setStage(null);
    callbacks.current.onBusyChange?.(true);
    try {
      if (dependency.requiredForUse !== false) await onBeforeInstall?.();
      if (installing.current !== operation || operation.cancelled) return;
      const result = await installAgentDependency(
        agentId,
        dependencyId,
        (p) => {
          if (ticket === generation.current) {
            setStage(
              S.installStages[p.stage] ??
                STRINGS.install.stages[p.stage] ??
                S.installing,
            );
          }
        },
      );
      if (ticket !== generation.current) return;
      setInfo(result);
      updateReadiness(result);
      await onInstalled?.();
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
      {!busy &&
        (error ||
          info?.dependencies.some((item) => item.status !== "ready")) && (
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
