import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { uiError } from "../runtime/ui_error";
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
}: {
  card: AgentCardModel;
  agents: AgentsState;
  inventory: ProgramInventory;
  onInstall?: () => Promise<unknown>;
  installDisabled?: boolean;
}) {
  const S = STRINGS.access;
  const { items, refresh } = inventory;
  const [busy, setBusy] = useState<"check" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const act = async (kind: "check" | "remove", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await agents.refresh();
      setConfirm(null);
    } catch (e) {
      setError(uiError(e, S.failure));
    } finally {
      await refresh();
      setBusy(null);
    }
  };
  const locked =
    !!busy || !!agents.busy[card.id] || card.status === "connected";
  const progress = agents.installProgress[card.id];
  return (
    <section className="program-manager" aria-label={S.manage}>
      <div className="s-head-row">
        <h3 className="s-h">{S.manage}</h3>
        <button
          className="btn btn-text"
          disabled={!!busy || inventory.loading}
          onClick={() => void refresh()}
        >
          {S.retry}
        </button>
      </div>
      <p className="auth-note">
        {card.status === "connected" ? S.disconnected : S.programReady}
      </p>
      {(error || inventory.error || agents.errors[card.id]) && (
        <div role="alert" className="ac-error">
          {error ?? inventory.error ?? agents.errors[card.id]}
        </div>
      )}
      {(busy === "check" || agents.busy[card.id] === "install") && (
        <p role="status">
          {busy === "check"
            ? S.checking
            : (STRINGS.install.stages[progress?.stage ?? "prepare"] ??
              STRINGS.common.loading)}
          <button
            className="btn btn-text"
            onClick={() => void agents.cancelInstall(card.id)}
          >
            {S.cancelOperation}
          </button>
        </p>
      )}
      {inventory.loading && (
        <p role="status" className="auth-note">
          {S.loading}
        </p>
      )}
      {!inventory.loading && !inventory.error && !items.length && (
        <p className="auth-note">{S.installationsEmpty}</p>
      )}
      {items.map((item) => (
        <div className="program-row" key={item.id}>
          <div className="program-row-main">
            <div>
              <strong>{item.version ?? S.unknownVersion}</strong>
              <span className="program-kind">
                {item.programOnly || !card.programEnv ? S.program : S.component}
              </span>
              <p className="auth-note">
                {item.managedRoot
                  ? S.managed
                  : item.source === "unverified"
                    ? S.unverifiedInstall
                    : S.external}
              </p>
              {item.programOnly && !item.selected && (
                <p className="auth-note">{S.notSelected}</p>
              )}
            </div>
            <div className="ac-actions">
              {item.selected ? (
                <span className="program-selected">
                  {item.inUse ? S.inUse : S.selected}
                </span>
              ) : (
                <button
                  className="btn btn-ghost"
                  disabled={
                    locked ||
                    card.status === "none" ||
                    card.status === "discovered"
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
              {item.managedRoot && (
                <button
                  className="btn btn-text"
                  disabled={locked || !item.canUninstall}
                  onClick={() => setConfirm(item.id)}
                >
                  {S.uninstall}
                </button>
              )}
            </div>
          </div>
          <details className="program-path">
            <summary>{S.pathDetails}</summary>
            <p className="installation-path">{item.path}</p>
          </details>
          {confirm === item.id && (
            <div className="access-confirm" role="alert">
              <p>{S.uninstallHint}</p>
              <p className="installation-path">{item.path}</p>
              <button
                className="btn btn-ghost"
                disabled={locked}
                onClick={() =>
                  void act("remove", () =>
                    invoke("agent_installation_uninstall", {
                      agentId: card.id,
                      installationId: item.id,
                    }),
                  )
                }
              >
                {S.uninstallConfirm}
              </button>
              <button
                className="btn btn-text"
                disabled={!!busy}
                onClick={() => setConfirm(null)}
              >
                {S.cancel}
              </button>
            </div>
          )}
        </div>
      ))}
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
        {card.installGuide && (
          <button
            className="btn btn-text"
            onClick={() =>
              void openUrl(card.installGuide!).catch((e) =>
                setError(uiError(e, S.failure)),
              )
            }
          >
            {S.guide}
          </button>
        )}
      </div>
      {card.programEnv && (
        <details className="program-advanced">
          <summary>{S.advanced}</summary>
          <p className="auth-note">{S.installLocation}</p>
          <button
            className="btn btn-ghost"
            disabled={locked}
            onClick={() =>
              void (async () => {
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
          {card.bundledProgram && card.programPath && (
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
        </details>
      )}
    </section>
  );
}
