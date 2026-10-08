import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
import { installProgressLabel } from "../runtime/program_progress";
import { ACCESS_STRINGS } from "../runtime/access_strings";
import { R5_PROGRAM_STRINGS as R } from "../runtime/r5_program_strings";
import { DangerConfirm } from "./DangerConfirm";
import "../r5-program-access.css";
export interface Installation {
  id: string;
  source: string;
  path: string;
  version: string | null;
  managedRoot: string | null;
  programOnly: boolean;
  selected: boolean;
  inUse: boolean;
  canUninstall: boolean;
}
export function useProgramInventory(
  card: AgentCardModel,
  busy: unknown,
  enabled = true,
) {
  const [items, setItems] = useState<Installation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++revision.current;
    setLoading(true);
    try {
      const next = await invoke<Installation[]>("agent_installations", {
        agentId: card.id,
      });
      if (ticket === revision.current) {
        setItems(next);
        setError(null);
      }
    } catch (e) {
      if (ticket === revision.current)
        setError(uiError(e, STRINGS.access.loadProgramsFailed));
    } finally {
      if (ticket === revision.current) setLoading(false);
    }
  }, [card.id]);
  useEffect(() => {
    if (enabled) void refresh();
    return () => {
      revision.current++;
    };
  }, [refresh, card.status, card.version, card.programPath, busy, enabled]);
  return { items, error, loading, refresh };
}
export type ProgramInventory = ReturnType<typeof useProgramInventory>;
export function programSummary(
  card: AgentCardModel,
  inventory: Pick<ProgramInventory, "items" | "loading" | "error">,
): string {
  const S = STRINGS.access;
  if (inventory.loading) return S.loading;
  if (inventory.error) return S.unknownVersion;
  const programs = inventory.items.filter(
    (item) => item.programOnly || !card.programEnv,
  );
  const selected = programs.find((item) => item.selected);
  const version =
    selected?.version ??
    (card.status === "discovered" ? card.localVersion : null);
  const label =
    version ??
    (card.bundledProgram && !card.programPath && card.source
      ? STRINGS.install.bundledProgram
      : S.unknownVersion);
  if (label === STRINGS.install.bundledProgram && programs.length === 0)
    return label;
  return `${label} · ${S.installedCount(programs.length)}`;
}
export function ProgramManager({
  card,
  agents,
  inventory,
  onInstall,
  installDisabled = false,
  showHeading = true,
  onConnect,
  connectDisabled = false,
  prerequisitesReady = true,
}: {
  card: AgentCardModel;
  agents: AgentsState;
  inventory: ProgramInventory;
  onInstall?: () => Promise<unknown>;
  installDisabled?: boolean;
  showHeading?: boolean;
  onConnect?: () => Promise<void>;
  connectDisabled?: boolean;
  prerequisitesReady?: boolean;
}) {
  const S = STRINGS.access;
  const { items, refresh } = inventory;
  const [busy, setBusy] = useState<"check" | "remove" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const operationBusy = !!busy || !!agents.busy[card.id];
  // Program changes end safe idle connections themselves on the backend;
  // only in-flight operations, inventory state and explicit blockers lock.
  const locked = operationBusy || inventory.loading || !!inventory.error;
  const act = async (
    kind: "check" | "remove" | "connect",
    fn: () => Promise<unknown>,
  ) => {
    if (
      locked ||
      (kind === "connect" && (connectDisabled || !prerequisitesReady))
    )
      return;
    setBusy(kind);
    setError(null);
    try {
      const result = await fn();
      if (result === false) return;
      await agents.refresh();
      // Connection display follows the refreshed card, including failed checks.
      if (kind !== "connect") setConfirm(null);
    } catch (e) {
      setError(uiError(e, S.failure));
    } finally {
      await refresh();
      setBusy(null);
    }
  };
  const progress = agents.installProgress[card.id];
  const current =
    items.find(
      (item) => item.selected && (item.programOnly || !card.programEnv),
    ) ?? items.find((item) => item.selected);
  const ready = card.status === "connected" || prerequisitesReady;
  const currentStatus =
    card.status === "connected"
      ? S.connected
      : prerequisitesReady
        ? S.prepared
        : R.preparationRequired;
  const otherItems = items.filter((item) => item.id !== current?.id);
  const externalSetup =
    card.status === "none" && !card.installable && !card.registerable;
  const officialUrl =
    card.installGuide ?? card.presentation?.sourceUrl ?? card.sourceUrl;
  const officialGuide = officialUrl && (
    <button
      className="btn btn-ghost"
      onClick={() =>
        void openUrl(officialUrl).catch((e) => setError(uiError(e, S.failure)))
      }
    >
      {R.officialGuide}
    </button>
  );
  const renderInstallation = (item: Installation, primary = false) => (
    <div className="program-row" data-selected={item.selected} key={item.id}>
      <div className="program-row-main">
        <div className="program-row-summary">
          <div className="program-row-title">
            <strong>
              {primary ? card.name : (item.version ?? S.unknownVersion)}
            </strong>
            <span
              className={
                item.selected && (!primary || ready)
                  ? "program-selected"
                  : "program-not-selected"
              }
            >
              {primary
                ? currentStatus
                : item.selected
                  ? item.inUse
                    ? S.inUse
                    : S.selected
                  : S.notSelected}
            </span>
          </div>
          {!primary && (
            <p className="program-row-description">
              {item.programOnly || !card.programEnv ? S.program : S.component}
              {" · "}
              {item.managedRoot ? S.managed : R.external}
            </p>
          )}
          <details className="program-path">
            <summary>{R.installationDetails}</summary>
            {primary && (
              <p>
                {item.programOnly || !card.programEnv ? S.program : S.component}{" "}
                · {item.version ?? S.unknownVersion}
              </p>
            )}
            <p>
              {item.managedRoot
                ? S.managed
                : item.source === "unverified"
                  ? S.unverifiedInstall
                  : S.external}
            </p>
            <p className="installation-path">{item.path}</p>
          </details>
        </div>
        <div className="ac-actions">
          {primary && card.status === "installed" && onConnect && (
            <button
              className={
                prerequisitesReady ? "btn btn-primary" : "btn btn-ghost"
              }
              disabled={locked || connectDisabled || !prerequisitesReady}
              onClick={() => void act("connect", onConnect)}
            >
              {ACCESS_STRINGS.connect}
            </button>
          )}
          {!item.selected && (
            <button
              className="btn btn-primary"
              disabled={
                locked || card.status === "none" || card.status === "discovered"
              }
              onClick={() =>
                void act("check", () =>
                  agents.selectInstallation(card.id, item.id),
                )
              }
            >
              {S.select}
            </button>
          )}
          {item.managedRoot && item.canUninstall && (
            <button
              className="btn btn-ghost"
              disabled={locked}
              onClick={() => {
                if (!locked && item.canUninstall) setConfirm(item.id);
              }}
            >
              {S.uninstall}
            </button>
          )}
        </div>
      </div>
      {confirm === item.id && (
        <DangerConfirm
          busy={!!busy}
          confirmLabel={S.uninstallConfirm}
          confirmDisabled={locked || !item.canUninstall}
          onConfirm={() => {
            if (!item.canUninstall) return;
            void act("remove", () =>
              invoke("agent_installation_uninstall", {
                agentId: card.id,
                installationId: item.id,
              }),
            );
          }}
          cancelLabel={S.cancel}
          onCancel={() => setConfirm(null)}
        >
          <p>{S.uninstallHint}</p>
          <p className="installation-path">{item.path}</p>
        </DangerConfirm>
      )}
    </div>
  );
  return (
    <section className="program-manager" aria-label={S.manage}>
      <div className="program-manager-heading s-head-row">
        {showHeading && <h3 className="s-h">{R.currentProgram}</h3>}
        <button
          className="btn btn-text"
          disabled={!!busy || inventory.loading}
          onClick={() => void refresh()}
        >
          {S.retry}
        </button>
      </div>
      {(error || inventory.error || agents.errors[card.id]) && (
        <div role="alert" className="ac-error">
          {error ?? inventory.error ?? agents.errors[card.id]}
        </div>
      )}
      {(busy === "connect" ||
        busy === "check" ||
        agents.busy[card.id] === "install") && (
        <p role="status">
          {busy === "connect"
            ? STRINGS.agents.connecting
            : busy === "check"
              ? S.checking
              : installProgressLabel(
                  progress,
                  STRINGS.install.stages[progress?.stage ?? "prepare"] ??
                    STRINGS.common.loading,
                )}
          {busy !== "connect" && (
            <button
              className="btn btn-text"
              onClick={() => void agents.cancelInstall(card.id)}
            >
              {S.cancelOperation}
            </button>
          )}
        </p>
      )}
      {inventory.loading && (
        <p role="status" className="auth-note">
          {S.loading}
        </p>
      )}
      {!current &&
        (card.status === "installed" || card.status === "connected") && (
          <div className="program-empty">
            <div className="program-row-title">
              <strong>{card.name}</strong>
              <span
                className={ready ? "program-selected" : "program-not-selected"}
              >
                {currentStatus}
              </span>
            </div>
            {card.status === "installed" && onConnect && (
              <button
                className={
                  prerequisitesReady ? "btn btn-primary" : "btn btn-ghost"
                }
                disabled={locked || connectDisabled || !prerequisitesReady}
                onClick={() => void act("connect", onConnect)}
              >
                {ACCESS_STRINGS.connect}
              </button>
            )}
          </div>
        )}
      {!current &&
        card.status !== "installed" &&
        card.status !== "connected" &&
        !inventory.loading &&
        !inventory.error && <p className="auth-note">{S.installationsEmpty}</p>}
      {current && (
        <div className="program-current">
          {renderInstallation(current, true)}
        </div>
      )}
      {externalSetup && officialGuide}
      {(!externalSetup || otherItems.length > 0 || card.programEnv) && (
        <details className="program-installation-management">
          <summary>{R.manageInstallations}</summary>
          {!!otherItems.length && (
            <div className="program-installations">
              {otherItems.map((item) => renderInstallation(item))}
            </div>
          )}
          <div className="ac-actions program-actions">
            {card.installable && (
              <button
                className="btn btn-ghost"
                disabled={locked || installDisabled || !onInstall}
                onClick={() => {
                  if (!locked && !installDisabled) void onInstall?.();
                }}
              >
                {card.programEnv ? S.componentUpdate : STRINGS.install.update}
              </button>
            )}
            {!externalSetup && officialGuide}
            {card.programEnv && (
              <button
                className="btn btn-ghost"
                disabled={locked}
                onClick={() =>
                  void (async () => {
                    if (locked) return;
                    try {
                      const path = await open({
                        directory: false,
                        multiple: false,
                      });
                      if (typeof path === "string")
                        await act("check", () =>
                          agents.selectProgram(card.id, path),
                        );
                    } catch (e) {
                      setError(uiError(e, S.failure));
                    }
                  })()
                }
              >
                {STRINGS.install.chooseProgram}
              </button>
            )}
            {card.programEnv && card.bundledProgram && card.programPath && (
              <button
                className="btn btn-text"
                disabled={locked}
                onClick={() =>
                  void act("check", () => agents.selectProgram(card.id, null))
                }
              >
                {STRINGS.install.bundled}
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
