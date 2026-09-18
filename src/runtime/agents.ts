/**
 * Agent catalog/connection client: invoke wrappers over the Tauri commands,
 * the AgentCard view-model derivation, and the `useAgents` state hook.
 *
 * Wire shapes mirror the serde output of `agent_catalog.rs`, `agent_install.rs`,
 * `acp_client/manager.rs`, `meta_store.rs` and `ui_transport.rs` (camelCase).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { useCallback, useEffect, useRef, useState } from "react";
import { STRINGS } from "./strings";

// ---------------------------------------------------------------------------
// Wire types (serde camelCase)
// ---------------------------------------------------------------------------

export type AgentLaunch =
  | { kind: "binary"; binary: string; args: string[] }
  | { kind: "npx"; package: string; args: string[] };

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
  /** Raw initialize response JSON from the last successful handshake. */
  handshake: unknown | null;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogEntry {
  agentId: string;
  displayName: string;
  description: string;
  registryId: string;
  installLaunch: AgentLaunch;
  discovered: DiscoveredBinary | null;
  registered: AgentRow | null;
  registryVersion: string | null;
  installable: boolean;
}

export interface AgentConnectionStatus {
  agentId: string;
  cwd: string;
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

export function agentInstall(agentId: string): Promise<AgentRow> {
  return invoke("agent_install", { agentId });
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
  /** `agent` | `terminal` | `api-key` */
  kind: string;
  /** Full argv when the method can run in the embedded terminal. */
  terminalCommand: string[] | null;
  /** Suggested env var name for `api-key` methods. */
  envName: string | null;
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
  id: string;
  data?: string;
  exit?: number;
}

export function authMethods(agentId: string): Promise<AuthMethodsResponse> {
  return invoke("auth_methods", { agentId });
}

export function authRun(
  agentId: string,
  methodId: string,
  options: {
    viaTerminal?: boolean;
    onOutput: Channel<PtyChunk>;
  },
): Promise<AuthRunResult> {
  return invoke("auth_run", {
    agentId,
    methodId,
    viaTerminal: options.viaTerminal ?? null,
    onOutput: options.onOutput,
  });
}

export function authSetApiKey(
  agentId: string,
  envName: string,
  key: string,
): Promise<void> {
  return invoke("auth_set_api_key", { agentId, envName, key });
}

export function agentLogout(agentId: string): Promise<void> {
  return invoke("agent_logout", { agentId });
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

export function ptyClose(id: string): Promise<void> {
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
  status: AgentCardStatus;
  /** Best-known version: live agent info > installed row > discovered probe. */
  version: string | null;
  /** Login methods reported by the live connection (empty when not connected). */
  authMethods: string[];
  discoveredPath: string | null;
  registryVersion: string | null;
  source: AgentSource | null;
  installable: boolean;
  /** The discovered binary can itself be registered and launched. */
  registerable: boolean;
  custom: boolean;
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
    description: entry.description,
    status,
    version:
      live?.agentVersion ??
      entry.registered?.version ??
      entry.discovered?.version ??
      null,
    authMethods: live?.authMethods ?? [],
    discoveredPath: entry.discovered?.path ?? null,
    registryVersion: entry.registryVersion,
    source: (entry.registered?.source as AgentSource | undefined) ?? null,
    installable: entry.installable,
    registerable:
      entry.installLaunch.kind === "binary" && entry.discovered !== null,
    custom: false,
  };
}

export function customAgentCard(
  row: AgentRow,
  statuses: AgentConnectionStatus[] | undefined,
): AgentCardModel {
  const live = liveConnection(statuses);
  return {
    id: row.id,
    name: row.name,
    description: row.command,
    status: live?.state === "ready" ? "connected" : "installed",
    version: live?.agentVersion ?? row.version,
    authMethods: live?.authMethods ?? [],
    discoveredPath: null,
    registryVersion: null,
    source: "custom",
    installable: false,
    registerable: false,
    custom: true,
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

export function agentStatusLabel(card: AgentCardModel): string {
  switch (card.status) {
    case "connected":
      return STRINGS.agents.status.connected(card.version);
    case "installed":
      return STRINGS.agents.status.installed(card.version);
    case "discovered":
      return STRINGS.agents.status.discovered(card.version);
    default:
      return STRINGS.agents.status.none;
  }
}

/** Identity block class + letter, keyed by agent id (F 稿身份系统). */
export function agentIdentity(
  agentId: string,
  name: string,
): { cls: string; letter: string } {
  const cls =
    agentId === "pi"
      ? "pi"
      : agentId === "opencode"
        ? "opencode"
        : agentId === "codex"
          ? "codex"
          : "unknown";
  const letter = (name.trim().charAt(0) || "?").toUpperCase();
  return { cls, letter };
}

// ---------------------------------------------------------------------------
// Per-agent "work on this project" preference
// ---------------------------------------------------------------------------

/** Settings key used in meta_store (`agent.<id>.work`); default is on. */
export function agentWorkKey(agentId: string): string {
  return `agent.${agentId}.work`;
}

const WORK_STORAGE_PREFIX = "farfold.agent.work.";

export function readAgentWork(
  agentId: string,
  settings: Record<string, unknown>,
): boolean {
  const stored = settings[agentWorkKey(agentId)];
  if (typeof stored === "boolean") return stored;
  return true;
}

/** Legacy localStorage value left over from before settings_set existed;
 *  migrated lazily on load, then removed. */
export function legacyAgentWork(agentId: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(WORK_STORAGE_PREFIX + agentId);
    if (raw === null) return null;
    window.localStorage.removeItem(WORK_STORAGE_PREFIX + agentId);
    return raw === "1";
  } catch {
    return null;
  }
}

export function writeAgentWork(agentId: string, on: boolean): void {
  void settingsSet(agentWorkKey(agentId), on).catch(() => undefined);
}

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
  errors: Record<string, string | null>;
  workEnabled: (agentId: string) => boolean;
  setWorkEnabled: (agentId: string, on: boolean) => void;
  refresh: () => Promise<void>;
  rescan: () => Promise<void>;
  connect: (card: AgentCardModel) => Promise<void>;
  reconnect: (card: AgentCardModel) => Promise<void>;
  disconnect: (agentId: string) => Promise<void>;
  remove: (agentId: string) => Promise<boolean>;
  addCustom: (input: {
    name: string;
    command: string;
    args: string[];
  }) => Promise<boolean>;
}

export function useAgents(): AgentsState {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [statuses, setStatuses] = useState<
    Record<string, AgentConnectionStatus[]>
  >({});
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [workOverrides, setWorkOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const [busy, setBusy] = useState<Record<string, AgentBusy | null>>({});
  const [scanning, setScanning] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const cwdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [snapshot, catalog] = await Promise.all([
      appInitialSnapshot(),
      catalogList(),
    ]);
    setRows(snapshot.agents);
    setSettings(snapshot.settings);
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

    // Migrate pre-settings_set localStorage work toggles into meta_store.
    const migrated = { ...snapshot.settings };
    let touched = false;
    for (const id of uniqueIds) {
      const key = agentWorkKey(id);
      if (typeof migrated[key] === "boolean") continue;
      const legacy = legacyAgentWork(id);
      if (legacy === null) continue;
      migrated[key] = legacy;
      touched = true;
      void settingsSet(key, legacy).catch(() => undefined);
    }
    if (touched) setSettings(migrated);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh()
      .catch((reason) => {
        if (!cancelled) setLoadError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const unlisten = listen<AgentConnectionStatus>("agent:status", (event) => {
      const status = event.payload;
      if (!status?.agentId) return;
      setStatuses((prev) => {
        const existing = prev[status.agentId] ?? [];
        const next =
          status.state === "closed"
            ? existing.filter((item) => item.cwd !== status.cwd)
            : [...existing.filter((item) => item.cwd !== status.cwd), status];
        return { ...prev, [status.agentId]: next };
      });
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, [refresh]);

  const connectCwd = useCallback(async (): Promise<string> => {
    if (cwdRef.current) return cwdRef.current;
    // Placeholder project root until the workspace picker lands (slice D).
    const home = await homeDir().catch(() => "/");
    cwdRef.current = home;
    return home;
  }, []);

  const setBusyFor = useCallback((agentId: string, value: AgentBusy | null) => {
    setBusy((prev) => ({ ...prev, [agentId]: value }));
  }, []);

  const setErrorFor = useCallback((agentId: string, value: string | null) => {
    setErrors((prev) => ({ ...prev, [agentId]: value }));
  }, []);

  const connect = useCallback(
    async (card: AgentCardModel) => {
      setBusyFor(card.id, "connect");
      setErrorFor(card.id, null);
      try {
        const cwd = await connectCwd();
        if (card.status === "installed" || card.custom) {
          // Already registered: connect directly.
        } else if (card.registerable && card.discoveredPath) {
          await agentRegister(card.id, card.discoveredPath);
        } else {
          setBusyFor(card.id, "install");
          await agentInstall(card.id);
          setBusyFor(card.id, "connect");
        }
        await agentConnect(card.id, cwd);
        await refresh();
      } catch (reason) {
        setErrorFor(
          card.id,
          `${STRINGS.agents.errors.connectFailed}：${reason}`,
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
    async (card: AgentCardModel) => {
      setBusyFor(card.id, "connect");
      setErrorFor(card.id, null);
      try {
        const cwd = await connectCwd();
        await agentDisconnect(card.id).catch(() => false);
        await agentConnect(card.id, cwd);
        await refresh();
      } catch (reason) {
        setErrorFor(
          card.id,
          `${STRINGS.agents.errors.connectFailed}：${reason}`,
        );
        await refresh().catch(() => undefined);
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
        await agentDisconnect(agentId);
      } catch (reason) {
        setErrorFor(agentId, String(reason));
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
        await refresh();
        return removed;
      } catch (reason) {
        setErrorFor(agentId, String(reason));
        return false;
      } finally {
        setBusyFor(agentId, null);
      }
    },
    [refresh, setBusyFor, setErrorFor],
  );

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      await catalogScan();
      await refresh();
    } catch (reason) {
      setErrors((prev) => ({
        ...prev,
        __scan: `${STRINGS.agents.errors.scanFailed}：${reason}`,
      }));
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  const addCustom = useCallback(
    async (input: { name: string; command: string; args: string[] }) => {
      try {
        await agentAddCustom({ ...input, env: {} });
        await refresh();
        return true;
      } catch (reason) {
        setErrors((prev) => ({ ...prev, __custom: String(reason) }));
        return false;
      }
    },
    [refresh],
  );

  const workEnabled = useCallback(
    (agentId: string) =>
      workOverrides[agentId] ?? readAgentWork(agentId, settings),
    [workOverrides, settings],
  );

  const setWorkEnabled = useCallback((agentId: string, on: boolean) => {
    writeAgentWork(agentId, on);
    setWorkOverrides((prev) => ({ ...prev, [agentId]: on }));
  }, []);

  const cards = mergeAgentCards(entries, rows, statuses);
  const connectedCards = cards.filter((card) => card.status === "connected");

  return {
    loading,
    loadError,
    cards,
    connectedCards,
    busy,
    scanning,
    errors,
    workEnabled,
    setWorkEnabled,
    refresh,
    rescan,
    connect,
    reconnect,
    disconnect,
    remove,
    addCustom,
  };
}
