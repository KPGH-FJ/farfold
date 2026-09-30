/**
 * Agent catalog/connection client: invoke wrappers over the Tauri commands,
 * the AgentCard view-model derivation, and the `useAgents` state hook.
 *
 * Wire shapes mirror the serde output of `agent_catalog.rs`, `agent_install.rs`,
 * `acp_client/manager.rs`, `meta_store.rs` and `ui_transport.rs` (camelCase).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { uiError } from "./ui_error";
import { threads } from "./sessions";
import { hasPendingRequests } from "./session_types";
import { STRINGS } from "./strings";
import { setupStorage } from "./setup_storage";
import type { InstallationInput } from "./installation_input";

// ---------------------------------------------------------------------------
// Wire types (serde camelCase)
// ---------------------------------------------------------------------------

export type AgentLaunch =
  | { kind: "binary"; binary: string; args: string[] }
  | { kind: "npx"; package: string; args: string[] }
  | { kind: "uvx"; package: string; args: string[] };

export interface DiscoveredBinary {
  agentId: string;
  path: string;
  version: string | null;
}

export type AgentSource = "discovered" | "registry" | "custom";

export interface AgentRow {
  id: string;
  name: string;
  /** `discovered` | `registry` | `custom` */
  source: string;
  command: string;
  args: string[];
  /** Serialized as an array of [key, value] pairs. */
  env: [string, string][];
  version: string | null;
  /** Safe public declaration snapshot from the last successful handshake. */
  handshake: unknown | null;
  createdAt: number;
  updatedAt: number;
}

/** Directory classification from public positioning, not verified local capabilities. */
export interface DirectoryPresentation {
  publisher: string;
  description: string;
  categories: ("编程" | "自动化" | "研究" | "轻量")[];
  sourceUrl: string;
}

export interface CatalogEntry {
  agentId: string;
  displayName: string;
  description: string;
  presentation?: DirectoryPresentation | null;
  registryId: string;
  installLaunch: AgentLaunch | null;
  discovered: DiscoveredBinary | null;
  registered: AgentRow | null;
  registryVersion: string | null;
  installable: boolean;
  /** Official device/portable distribution; absent/null is not a platform rejection. */
  platformAvailable?: boolean | null;
  sourceUrl?: string | null;
  icon?: string | null;
  programEnv?: string | null;
  bundledProgram?: boolean;
  installGuide?: string;
  rollbackAvailable?: boolean;
  programPath?: string | null;
}

export interface AgentConnectionStatus {
  agentId: string;
  cwd: string;
  serviceContext?: string;
  /** `connecting` | `ready` | `closed` | `failed` */
  state: string;
  agentName: string | null;
  agentVersion: string | null;
  authMethods: string[];
}

export interface AppInitialSnapshot {
  agents: AgentRow[];
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function appInitialSnapshot(): Promise<AppInitialSnapshot> {
  return invoke("app_initial_snapshot");
}

export function appDefaultWorkingDirectory(): Promise<string> {
  return invoke("app_default_working_directory");
}

export function catalogList(): Promise<CatalogEntry[]> {
  return invoke("catalog_list");
}

export function catalogScan(): Promise<DiscoveredBinary[]> {
  return invoke("catalog_scan");
}

export function agentRegister(
  agentId: string,
  path: string,
): Promise<AgentRow> {
  return invoke("agent_register", { agentId, path });
}

export function agentAddCustom(input: {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<AgentRow> {
  return invoke("agent_add_custom", input);
}

export interface InstallProgress {
  stage: string;
  bytes: number | null;
  total: number | null;
}
export function agentInstall(
  agentId: string,
  onProgress: (p: InstallProgress) => void,
  installationInput?: InstallationInput,
): Promise<AgentRow> {
  const progress = new Channel<InstallProgress>();
  progress.onmessage = onProgress;
  return invoke("agent_install", {
    agentId,
    progress,
    ...(installationInput ? { installationInput } : {}),
  });
}

export function agentConnect(
  agentId: string,
  cwd: string,
): Promise<AgentConnectionStatus> {
  return invoke("agent_connect", { agentId, cwd });
}

export function agentDisconnect(agentId: string): Promise<boolean> {
  return invoke("agent_disconnect", { agentId });
}

export function agentRemove(agentId: string): Promise<boolean> {
  return invoke("agent_remove", { agentId });
}

export function agentStatus(agentId: string): Promise<AgentConnectionStatus[]> {
  return invoke("agent_status", { agentId });
}

// ---------------------------------------------------------------------------
// Auth / settings / PTY commands
// ---------------------------------------------------------------------------

export interface AuthMethodInfo {
  id: string;
  name: string;
  description: string | null;
  /** `agent` | `terminal` | `api-key` | `environment` | `unsupported` */
  kind: string;
  /** Retained wire slot; current public snapshots do not expose command arguments. */
  terminalCommand: string[] | null;
  /** Suggested env var name for `api-key` methods. */
  envName: string | null;
  /** Validated public variable names; never environment values. */
  envNames?: string[];
  purpose?: "login" | "setup";
  completion?: "exit_code" | "return_and_verify";
  /** Safe explanation when this declared automatic login cannot be run. */
  unavailableReason?: string | null;
}

export interface AuthMethodsResponse {
  methods: AuthMethodInfo[];
  canLogout: boolean;
}

export interface AuthRunResult {
  /** `agent` | `terminal` | `api-key` */
  kind: string;
  ptyId: string | null;
}

/** Output frame pushed over the PTY channel: `{id, data?}` (base64 chunk) or
 *  `{id, exit}` when the child terminates. */
export interface PtyChunk {
  id?: string;
  data?: string;
  exit?: number;
  authStatus?: "unknown";
}

export function authMethods(
  agentId: string,
  target: { cwd?: string | null; source?: string } = {},
): Promise<AuthMethodsResponse> {
  return invoke("auth_methods", {
    agentId,
    cwd: target.cwd ?? null,
    source: target.source ?? null,
  });
}

export function authRun(
  agentId: string,
  methodId: string,
  options: {
    cwd: string;
    source?: string;
    attemptId: string;
    viaTerminal?: boolean;
    onOutput: Channel<PtyChunk>;
  },
): Promise<AuthRunResult> {
  return invoke("auth_run", {
    agentId,
    methodId,
    cwd: options.cwd,
    source: options.source ?? null,
    attemptId: options.attemptId,
    viaTerminal: options.viaTerminal ?? null,
    onOutput: options.onOutput,
  });
}

export function agentLogout(
  agentId: string,
  options: {
    cwd: string;
    source?: string;
    attemptId: string;
    onOutput: Channel<PtyChunk>;
  },
): Promise<void> {
  return invoke("agent_logout", {
    agentId,
    ...options,
    source: options.source ?? null,
  });
}

export function settingsGet(key: string): Promise<unknown> {
  return invoke("settings_get", { key });
}

export function settingsSet(key: string, value: unknown): Promise<void> {
  return invoke("settings_set", { key, value });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyAwait(id: string): Promise<number> {
  return invoke("pty_await", { id });
}

export function ptyClose(id: string): Promise<number | null> {
  return invoke("pty_close", { id });
}

// ---------------------------------------------------------------------------
// AgentCard view-model
// ---------------------------------------------------------------------------

export type AgentCardStatus = "none" | "discovered" | "installed" | "connected";

export interface AgentCardModel {
  id: string;
  name: string;
  description: string;
  presentation?: DirectoryPresentation | null;
  status: AgentCardStatus;
  /** Best-known version: live agent info > installed row > discovered probe. */
  version: string | null;
  /** A discovered executable's version, separate from connection/package info. */
  localVersion?: string | null;
  /** Login methods reported by the live connection (empty when not connected). */
  authMethods: string[];
  discoveredPath: string | null;
  registryVersion: string | null;
  source: AgentSource | null;
  installable: boolean;
  registryId?: string;
  platformAvailable?: boolean | null;
  sourceUrl?: string | null;
  icon?: string | null;
  programEnv?: string | null;
  bundledProgram?: boolean;
  installGuide?: string;
  rollbackAvailable?: boolean;
  programPath?: string | null;
  /** The discovered binary can itself be registered and launched. */
  registerable: boolean;
  custom: boolean;
  /** Raw initialize response JSON (`agentCapabilities`, `authMethods`, …). */
  handshake: unknown | null;
}

function liveConnection(
  statuses: AgentConnectionStatus[] | undefined,
): AgentConnectionStatus | null {
  if (!statuses) return null;
  return (
    statuses.find((status) => status.state === "ready") ??
    statuses.find((status) => status.state === "connecting") ??
    null
  );
}

export function toAgentCard(
  entry: CatalogEntry,
  statuses: AgentConnectionStatus[] | undefined,
): AgentCardModel {
  const live = liveConnection(statuses);
  const connected = live?.state === "ready";
  const discoveredRegisteredVersion =
    entry.registered?.source === "discovered" &&
    entry.discovered?.path === entry.registered.command
      ? entry.discovered.version
      : null;
  const status: AgentCardStatus = connected
    ? "connected"
    : entry.registered
      ? "installed"
      : entry.discovered
        ? "discovered"
        : "none";
  return {
    id: entry.agentId,
    name: entry.displayName,
    description: catalogDescription(entry.description),
    presentation: entry.presentation,
    status,
    version:
      live?.agentVersion ??
      discoveredRegisteredVersion ??
      entry.registered?.version ??
      entry.discovered?.version ??
      null,
    authMethods:
      liveConnection(statuses?.filter((status) => !status.serviceContext))
        ?.authMethods ?? [],
    localVersion: entry.discovered?.version ?? null,
    discoveredPath: entry.discovered?.path ?? null,
    registryVersion: entry.registryVersion,
    source: (entry.registered?.source as AgentSource | undefined) ?? null,
    installable: entry.installable,
    registryId: entry.registryId,
    platformAvailable: entry.platformAvailable,
    sourceUrl: entry.sourceUrl,
    icon: entry.icon,
    programEnv: entry.programEnv,
    bundledProgram: entry.bundledProgram,
    installGuide: entry.installGuide,
    rollbackAvailable: entry.rollbackAvailable,
    programPath: entry.programEnv
      ? (entry.registered?.env.find(
          ([name]) => name === entry.programEnv,
        )?.[1] ?? null)
      : entry.registered?.command,
    registerable:
      entry.installLaunch?.kind === "binary" && entry.discovered !== null,
    custom: false,
    handshake: entry.registered?.handshake ?? null,
  };
}

/** Directory descriptions are external prose, never launch instructions. */
function catalogDescription(description: string): string {
  return (
    description
      .trim()
      .replace(/\b(?:ACP|adapter|sidecar)\b/gi, "Agent 接入")
      .replace(/\b(?:Runtime|Host)\b/gi, "环境")
      .replace(/\b(?:Session|Turn)\b/gi, "对话")
      .replace(/\bWorking Copy\b/gi, "文件夹")
      .replace(/\b(?:JSON|envelope)\b/gi, "数据")
      .replace(
        /原生|绑定|代次|投影|占用|构建|引用|对账|沉降|上游|握手/g,
        "连接",
      )
      .replace(
        /(Agent 接入|环境|对话|文件夹|数据|连接)(?:[\s/·—–-]+\1)+/g,
        "$1",
      ) || STRINGS.agents.catalogDescription
  );
}

export function customAgentCard(
  row: AgentRow,
  statuses: AgentConnectionStatus[] | undefined,
): AgentCardModel {
  const live = liveConnection(statuses);
  const source: AgentSource =
    row.source === "registry" || row.source === "discovered"
      ? row.source
      : "custom";
  return {
    id: row.id,
    name: row.name,
    description:
      source === "custom"
        ? STRINGS.agents.custom.title
        : STRINGS.agents.catalogDescription,
    status: live?.state === "ready" ? "connected" : "installed",
    version: live?.agentVersion ?? row.version,
    authMethods:
      liveConnection(statuses?.filter((status) => !status.serviceContext))
        ?.authMethods ?? [],
    discoveredPath: null,
    registryVersion: null,
    source,
    installable: false,
    platformAvailable: null,
    registryId:
      source === "registry" ? row.id.replace(/^registry:/, "") : undefined,
    registerable: false,
    custom: source === "custom",
    handshake: row.handshake ?? null,
  };
}

/** `agentCapabilities.promptCapabilities` from the stored handshake. */
export function promptCapabilities(card: AgentCardModel | null | undefined): {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
} {
  const caps = (
    card?.handshake as {
      agentCapabilities?: {
        promptCapabilities?: {
          image?: boolean;
          audio?: boolean;
          embeddedContext?: boolean;
        };
      };
    } | null
  )?.agentCapabilities?.promptCapabilities;
  return {
    image: caps?.image === true,
    audio: caps?.audio === true,
    embeddedContext: caps?.embeddedContext === true,
  };
}

/** Catalog entries plus any registered rows the catalog does not cover
 *  (custom agents), each merged with its live connection status. */
export function mergeAgentCards(
  entries: CatalogEntry[],
  rows: AgentRow[],
  statuses: Record<string, AgentConnectionStatus[]>,
): AgentCardModel[] {
  const catalogIds = new Set(entries.map((entry) => entry.agentId));
  const cards = entries.map((entry) =>
    toAgentCard(entry, statuses[entry.agentId]),
  );
  const customs = rows
    .filter((row) => !catalogIds.has(row.id))
    .map((row) => customAgentCard(row, statuses[row.id]));
  return [...cards, ...customs];
}

/** A status event ends only its own project and model-source connection. */
export function mergeConnectionStatus(
  existing: AgentConnectionStatus[],
  status: AgentConnectionStatus,
): AgentConnectionStatus[] {
  const remaining = existing.filter(
    (item) =>
      item.cwd !== status.cwd ||
      (item.serviceContext ?? "") !== (status.serviceContext ?? ""),
  );
  return status.state === "closed" ? remaining : [...remaining, status];
}

export const AGENT_BRANDS: Record<
  string,
  { logo: string; description: string; monochrome?: boolean }
> = {
  opencode: {
    logo: "/agents/opencode.svg",
    monochrome: true,
    description: STRINGS.agents.brands.opencode,
  },
  codex: {
    logo: "/agents/codex.svg",
    monochrome: true,
    description: STRINGS.agents.brands.codex,
  },
  pi: { logo: "/agents/pi-color.svg", description: STRINGS.agents.brands.pi },
};

/** Identity block class + letter, derived from the agent id — one code
 *  path for every agent, custom ones included (no per-agent branches). */
export function agentIdentity(
  agentId: string,
  name: string,
): { cls: string; letter: string } {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  return { cls: `c${hash % 5}`, letter };
}

// ---------------------------------------------------------------------------
// Per-agent "work on this project" preference
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// useAgents hook
// ---------------------------------------------------------------------------

export type AgentBusy = "connect" | "install" | "disconnect" | "remove";

export interface AgentsState {
  loading: boolean;
  loadError: string | null;
  cards: AgentCardModel[];
  connectedCards: AgentCardModel[];
  busy: Record<string, AgentBusy | null>;
  scanning: boolean;
  installProgress: Record<string, InstallProgress>;
  install: (
    card: AgentCardModel,
    input?: InstallationInput,
  ) => Promise<boolean>;
  cancelInstall: (id: string) => Promise<void>;
  selectProgram: (id: string, path: string | null) => Promise<boolean>;
  selectInstallation: (id: string, installationId: string) => Promise<boolean>;
  errors: Record<string, string | null>;
  refresh: () => Promise<void>;
  rescan: () => Promise<void>;
  connect: (
    card: AgentCardModel,
    cwd?: string,
    input?: InstallationInput,
  ) => Promise<void>;
  reconnect: (card: AgentCardModel, cwd?: string) => Promise<void>;
  disconnect: (agentId: string) => Promise<void>;
  remove: (agentId: string) => Promise<boolean>;
  addCustom: (input: {
    name: string;
    command: string;
    args: string[];
  }) => Promise<string | null>;
}

export function useAgents(): AgentsState {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [statuses, setStatuses] = useState<
    Record<string, AgentConnectionStatus[]>
  >({});
  const [busy, setBusy] = useState<Record<string, AgentBusy | null>>({});
  const [scanning, setScanning] = useState(false);
  const [installProgress, setInstallProgress] = useState<
    Record<string, InstallProgress>
  >({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const refresh = useCallback(async () => {
    const [snapshot, catalog] = await Promise.all([
      appInitialSnapshot(),
      catalogList(),
    ]);
    setRows(snapshot.agents);
    setEntries(catalog);
    const catalogIds = new Set(catalog.map((entry) => entry.agentId));
    const ids = [
      ...catalog
        .filter((entry) => entry.registered)
        .map((entry) => entry.agentId),
      ...snapshot.agents
        .filter((row) => !catalogIds.has(row.id))
        .map((row) => row.id),
    ];
    const uniqueIds = [...new Set(ids)];
    const statusPairs = await Promise.all(
      uniqueIds.map(async (id) => [id, await agentStatus(id)] as const),
    );
    setStatuses(Object.fromEntries(statusPairs));
    setLoadError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch((reason) => {
        if (!cancelled)
          setLoadError(uiError(reason, STRINGS.repair.requestFailed));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const unlistenCatalog = listen("catalog:updated", () => {
      void refresh();
    });
    const unlisten = listen<AgentConnectionStatus>("agent:status", (event) => {
      const status = event.payload;
      if (!status?.agentId) return;
      setStatuses((prev) => {
        const existing = prev[status.agentId] ?? [];
        const next = mergeConnectionStatus(existing, status);
        return { ...prev, [status.agentId]: next };
      });
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
      void unlistenCatalog.then((off) => off());
    };
  }, [refresh]);

  // One background scan per hook lifetime warms the catalog caches;
  // `catalog_list` itself never probes binaries or the network.
  const scannedRef = useRef(false);
  useEffect(() => {
    if (loading || scannedRef.current) return;
    scannedRef.current = true;
    setScanning(true);
    void catalogScan()
      .then(async () => {
        await refresh();
        setErrors((prev) => ({ ...prev, __scan: null }));
      })
      .catch(() => {
        setErrors((prev) => ({
          ...prev,
          __scan: STRINGS.agents.errors.scanFailed,
        }));
      })
      .finally(() => setScanning(false));
  }, [loading, refresh]);

  /** Connect target: the project the user picked in settings. No project
   *  → refuse rather than silently spawning an agent in $HOME. */
  const connectCwd = useCallback((cwd?: string): string => {
    if (!cwd) throw new Error(STRINGS.repair.needProjectFirst);
    return cwd;
  }, []);

  const setBusyFor = useCallback((agentId: string, value: AgentBusy | null) => {
    setBusy((prev) => ({ ...prev, [agentId]: value }));
  }, []);

  const setErrorFor = useCallback((agentId: string, value: string | null) => {
    setErrors((prev) => ({ ...prev, [agentId]: value }));
  }, []);

  const connect = useCallback(
    async (card: AgentCardModel, cwd?: string, input?: InstallationInput) => {
      setBusyFor(card.id, "connect");
      setErrorFor(card.id, null);
      try {
        const target = connectCwd(cwd);
        if (card.status === "installed" || card.custom) {
          // Already registered: connect directly.
        } else if (card.registerable && card.discoveredPath) {
          await agentRegister(card.id, card.discoveredPath);
        } else {
          setBusyFor(card.id, "install");
          await agentInstall(
            card.id,
            (p) => setInstallProgress((prev) => ({ ...prev, [card.id]: p })),
            input,
          );
          setBusyFor(card.id, "connect");
        }
        await agentConnect(card.id, target);
        await refresh();
      } catch (reason) {
        setErrorFor(
          card.id,
          uiError(reason, STRINGS.agents.errors.connectFailed),
        );
        await refresh().catch(() => undefined);
      } finally {
        setBusyFor(card.id, null);
      }
    },
    [connectCwd, refresh, setBusyFor, setErrorFor],
  );

  /** Drop the live connection and connect again (picks up env/auth changes). */
  const reconnect = useCallback(
    async (card: AgentCardModel, cwd?: string) => {
      setBusyFor(card.id, "connect");
      setErrorFor(card.id, null);
      try {
        if (
          [...threads.getSnapshot().threads.values()].some(
            (t) =>
              t.agentId === card.id &&
              (t.running ||
                t.submitting ||
                t.stopping ||
                t.stopUnconfirmed ||
                hasPendingRequests(t) ||
                t.uncertainPrompt),
          )
        )
          throw new Error(STRINGS.credentials.activeTasks);
        const target = connectCwd(cwd);
        await agentDisconnect(card.id);
        await agentConnect(card.id, target);
        await refresh();
      } catch (reason) {
        setErrorFor(
          card.id,
          uiError(reason, STRINGS.agents.errors.connectFailed),
        );
        await refresh().catch(() => undefined);
        throw reason;
      } finally {
        setBusyFor(card.id, null);
      }
    },
    [connectCwd, refresh, setBusyFor, setErrorFor],
  );

  const disconnect = useCallback(
    async (agentId: string) => {
      setBusyFor(agentId, "disconnect");
      setErrorFor(agentId, null);
      try {
        if (
          [...threads.getSnapshot().threads.values()].some(
            (t) =>
              t.agentId === agentId &&
              (t.running ||
                t.submitting ||
                t.stopping ||
                t.stopUnconfirmed ||
                hasPendingRequests(t) ||
                t.uncertainPrompt),
          )
        )
          throw new Error(STRINGS.credentials.activeTasks);
        await agentDisconnect(agentId);
      } catch (reason) {
        setErrorFor(agentId, uiError(reason, STRINGS.repair.requestFailed));
      } finally {
        setBusyFor(agentId, null);
        await refresh().catch(() => undefined);
      }
    },
    [refresh, setBusyFor, setErrorFor],
  );

  const remove = useCallback(
    async (agentId: string) => {
      setBusyFor(agentId, "remove");
      setErrorFor(agentId, null);
      try {
        const removed = await agentRemove(agentId);
        // Removal has already changed the registration. A separate progress
        // save failure stays retryable in setupStorage without undoing it.
        if (removed) await setupStorage.forget(agentId).catch(() => undefined);
        return removed;
      } catch (reason) {
        setErrorFor(agentId, uiError(reason, STRINGS.repair.requestFailed));
        return false;
      } finally {
        await refresh().catch((reason) => {
          setLoadError(uiError(reason, STRINGS.repair.requestFailed));
        });
        setBusyFor(agentId, null);
      }
    },
    [refresh, setBusyFor, setErrorFor],
  );

  const rescan = useCallback(async () => {
    setScanning(true);
    setErrors((prev) => ({ ...prev, __scan: null }));
    try {
      await catalogScan();
      await refresh();
    } catch (reason) {
      setErrors((prev) => ({
        ...prev,
        __scan: STRINGS.agents.errors.scanFailed,
      }));
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const addCustom = useCallback(
    async (input: { name: string; command: string; args: string[] }) => {
      setErrors((prev) => ({ ...prev, __custom: null }));
      try {
        const added = await agentAddCustom({ ...input, env: {} });
        await refresh().catch((reason) => {
          setLoadError(uiError(reason, STRINGS.repair.requestFailed));
        });
        return added.id;
      } catch (reason) {
        setErrors((prev) => ({
          ...prev,
          __custom: uiError(reason, STRINGS.repair.requestFailed),
        }));
        return null;
      }
    },
    [refresh],
  );

  const install = async (card: AgentCardModel, input?: InstallationInput) => {
    setBusyFor(card.id, "install");
    setErrorFor(card.id, null);
    try {
      await agentInstall(
        card.id,
        (p) => setInstallProgress((prev) => ({ ...prev, [card.id]: p })),
        input,
      );
      return true;
    } catch (reason) {
      setErrorFor(card.id, uiError(reason, STRINGS.install.failed));
      setInstallProgress((prev) => ({
        ...prev,
        [card.id]: { stage: "stopped", bytes: null, total: null },
      }));
      return false;
    } finally {
      setBusyFor(card.id, null);
      await refresh().catch(() => undefined);
    }
  };
  const changeProgram = async (
    id: string,
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    setBusyFor(id, "install");
    setErrorFor(id, null);
    setInstallProgress((prev) => ({
      ...prev,
      [id]: { stage: "check", bytes: null, total: null },
    }));
    try {
      await invoke(command, { agentId: id, ...args });
      return true;
    } catch (reason) {
      setErrorFor(id, uiError(reason, STRINGS.install.changeFailed));
      return false;
    } finally {
      setBusyFor(id, null);
      setInstallProgress((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await refresh().catch(() => undefined);
    }
  };
  const cancelInstall = async (id: string) => {
    await invoke("agent_install_cancel", { agentId: id }).catch((reason) =>
      setErrorFor(id, uiError(reason, STRINGS.install.cancelFailed)),
    );
  };
  const selectProgram = (id: string, path: string | null) =>
    changeProgram(id, "agent_select_program", { path });
  const selectInstallation = (id: string, installationId: string) =>
    changeProgram(id, "agent_installation_select", { installationId });
  const cards = mergeAgentCards(entries, rows, statuses);
  const connectedCards = cards.filter((card) => card.status === "connected");

  return {
    loading,
    loadError,
    cards,
    connectedCards,
    busy,
    scanning,
    installProgress,
    install,
    cancelInstall,
    selectProgram,
    selectInstallation,
    errors,
    refresh,
    rescan,
    connect,
    reconnect,
    disconnect,
    remove,
    addCustom,
  };
}
