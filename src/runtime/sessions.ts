/**
 * Thread/session client: invoke wrappers over the session commands, a
 * store holding every open conversation's normalized transcript state,
 * and the pure `applyUpdate` projection that maps raw agent updates onto
 * thread items.
 *
 * Wire shapes mirror `acp_client/session_commands.rs`,
 * `acp_client/pump.rs` and `meta_store.rs` (camelCase). Raw updates arrive
 * over a per-conversation `Channel` as `{sessionId, update}` envelopes;
 * side-band events carry `kind`:
 * `permissionRequest` | `turnEnd` | `connectionLost` | `notification`.
 *
 * Naming note: user-facing vocabulary is "会话/thread"; `session*` stays
 * inside this runtime module only (AGENTS.md vocabulary rule).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  applyElicitation,
  applyTerminalOutput,
  normalizeArtifact,
  paneCards,
  roundArtifactCount,
} from "./artifacts";
import type {
  ArtifactView,
  ElicitationView,
  PaneCard,
  TerminalTail,
} from "./artifacts";
import { STRINGS } from "./strings";

export type { ArtifactView, ElicitationView, PaneCard, TerminalTail };
export { applyElicitation, applyTerminalOutput, normalizeArtifact, paneCards };

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** meta_store session row (`<agentId>:<cwd>:<nativeSessionId>`). */
export interface IndexRow {
  id: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string | null;
  title: string | null;
  configOptions: unknown | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** `session_open` result. */
export interface OpenResult {
  nativeSessionId: string;
  /** Canonicalized cwd — session keys must be built from this. */
  cwd: string;
  configOptions: unknown;
  modes?: unknown;
  models?: unknown;
  meta?: unknown;
  resumed: boolean;
  warnings: string[];
}

/** `session_list` merged entry (backend `SessionListEntry`, camelCase). */
export interface SessionListEntry {
  id: string | null;
  nativeSessionId: string;
  title: string | null;
  updatedAt: number | null;
  /** `agent` when the agent's own list reported it, else `farfold`. */
  source: string;
  pinned: boolean;
  archived: boolean;
}

/** An agent-side session with no Farfold index row yet — shown in the
 *  sidebar under `source: "agent"`; opening it resumes by native id and
 *  materializes the index row. */
export interface AgentOnlyRow {
  key: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  title: string | null;
  updatedAt: number;
}

/** View-model types live in `session_types.ts` (file-size cap); re-export
 *  so `../runtime/sessions` imports keep working. */
import type {
  Attachment,
  AvailableCommand,
  ConfigChoice,
  ConfigOptionView,
  PendingPermission,
  PermissionOption,
  PlanEntry,
  PromptBlock,
  ThreadItem,
  ThreadState,
  ToolCallView,
  ToolContent,
  ToolLocation,
} from "./session_types";
export * from "./session_types";

export function freshThreadState(
  key: string,
  agentId: string,
  cwd: string,
  nativeSessionId: string,
): ThreadState {
  return {
    key,
    agentId,
    cwd,
    nativeSessionId,
    title: null,
    items: [],
    running: false,
    queued: [],
    pendingPermission: null,
    pendingElicitation: null,
    artifacts: [],
    terminalTails: {},
    artifactPaneOpen: false,
    artifactsHydrated: false,
    roundItemBase: 0,
    roundArtifactBase: 0,
    configOptions: [],
    usage: null,
    availableCommands: [],
    currentModeId: null,
    connectionLost: false,
    prompted: false,
    resumed: false,
    openError: null,
    unrecoverable: false,
    metaDirty: false,
  };
}

// ---------------------------------------------------------------------------
// Pure normalization (unit-tested)
// ---------------------------------------------------------------------------

let itemSeq = 0;
const nextItemId = () => `it-${++itemSeq}`;

function textOf(content: unknown): string | null {
  if (
    content &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "text" &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    return (content as { text: string }).text;
  }
  return null;
}

function lastItem(s: ThreadState): ThreadItem | undefined {
  return s.items[s.items.length - 1];
}

/** Close any open-ended streaming flag (a different update arrived). */
function sealStreams(s: ThreadState): void {
  for (const item of s.items) {
    if (
      (item.kind === "user" ||
        item.kind === "agent" ||
        item.kind === "thought") &&
      item.streaming
    ) {
      item.streaming = false;
    }
  }
}

function pushRaw(s: ThreadState, update: unknown, label?: string): void {
  sealStreams(s);
  s.items.push({
    kind: "raw",
    id: nextItemId(),
    update,
    label,
    time: Date.now(),
  });
}

function appendStreamText(
  s: ThreadState,
  kind: "user" | "agent" | "thought",
  content: unknown,
): void {
  const text = textOf(content);
  if (text === null) {
    pushRaw(s, content ?? {});
    return;
  }
  const last = lastItem(s);
  if (last && last.kind === kind && last.streaming) {
    last.text += text;
    return;
  }
  // Echo de-dup: a live agent may replay the user's message we already
  // rendered optimistically; skip chunks fully contained in it.
  if (
    kind === "user" &&
    last &&
    last.kind === "user" &&
    last.text.includes(text)
  ) {
    return;
  }
  if (kind !== "user") sealStreams(s);
  s.items.push({
    kind,
    id: nextItemId(),
    text,
    streaming: true,
    time: Date.now(),
    ...(kind === "user" ? { attachments: [] } : {}),
  } as ThreadItem);
}

function normalizeLocations(raw: unknown): ToolLocation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((loc) => ({
      path: String((loc as { path?: unknown })?.path ?? ""),
      line:
        typeof (loc as { line?: unknown })?.line === "number"
          ? ((loc as { line: number }).line ?? undefined)
          : undefined,
    }))
    .filter((loc) => loc.path.length > 0);
}

function normalizeToolContent(raw: unknown): ToolContent {
  const c = raw as Record<string, unknown> | null;
  switch (c?.type) {
    case "diff":
      return {
        type: "diff",
        path: String(c.path ?? ""),
        oldText: typeof c.oldText === "string" ? c.oldText : null,
        newText: String(c.newText ?? ""),
      };
    case "terminal":
      return { type: "terminal", terminalId: String(c.terminalId ?? "") };
    case "content": {
      const inner = c.content as Record<string, unknown> | null;
      if (inner?.type === "text") {
        return { type: "text", text: String(inner.text ?? "") };
      }
      if (inner?.type === "image") {
        return {
          type: "image",
          data: String(inner.data ?? ""),
          mimeType: String(inner.mimeType ?? ""),
        };
      }
      if (inner?.type === "resource_link") {
        return {
          type: "link",
          name: String(inner.name ?? inner.uri ?? ""),
          uri: String(inner.uri ?? ""),
        };
      }
      if (inner?.type === "resource") {
        const res = inner.resource as Record<string, unknown> | null;
        return {
          type: "text",
          text: String(res?.text ?? res?.uri ?? ""),
        };
      }
      return { type: "raw", value: inner };
    }
    default:
      return { type: "raw", value: raw };
  }
}

function normalizeToolContents(raw: unknown): ToolContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeToolContent);
}

function findToolItem(s: ThreadState, toolCallId: string): number {
  return s.items.findIndex(
    (item) => item.kind === "tool" && item.call.toolCallId === toolCallId,
  );
}

function upsertToolCall(s: ThreadState, update: Record<string, unknown>): void {
  const toolCallId = String(update.toolCallId ?? "");
  if (!toolCallId) {
    pushRaw(s, update);
    return;
  }
  sealStreams(s);
  const index = findToolItem(s, toolCallId);
  const call: ToolCallView =
    index >= 0
      ? (s.items[index] as { kind: "tool"; call: ToolCallView }).call
      : {
          toolCallId,
          title: "",
          kind: "other",
          status: "pending",
          locations: [],
          content: [],
          startedAt: Date.now(),
        };
  if (update.title !== undefined && update.title !== null) {
    call.title = String(update.title);
  }
  if (update.name !== undefined && update.name !== null) {
    call.name = String(update.name);
  }
  if (update.kind !== undefined && update.kind !== null) {
    call.kind = String(update.kind);
  }
  if (update.status !== undefined && update.status !== null) {
    call.status = String(update.status);
  }
  if (update.locations !== undefined) {
    call.locations = normalizeLocations(update.locations);
  }
  if (update.content !== undefined) {
    call.content = normalizeToolContents(update.content);
  }
  if (update.rawInput !== undefined) call.rawInput = update.rawInput;
  if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
  if (
    (call.status === "completed" || call.status === "failed") &&
    call.endedAt === undefined
  ) {
    call.endedAt = Date.now();
  }
  if (index < 0) {
    s.items.push({ kind: "tool", id: nextItemId(), call });
  }
}

function normalizePlanEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => ({
    content: String((e as { content?: unknown })?.content ?? ""),
    priority: String((e as { priority?: unknown })?.priority ?? "medium"),
    status: String((e as { status?: unknown })?.status ?? "pending"),
  }));
}

function flattenChoices(raw: unknown): ConfigChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigChoice[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    if (entry && typeof entry === "object" && Array.isArray(entry.options)) {
      // Grouped select: {group, name, options:[{value,name}]}
      for (const opt of entry.options as Record<string, unknown>[]) {
        out.push({
          value: String(opt?.value ?? ""),
          name: String(opt?.name ?? opt?.value ?? ""),
          group: String(entry.name ?? entry.group ?? ""),
        });
      }
    } else if (entry && typeof entry === "object") {
      out.push({
        value: String(entry.value ?? ""),
        name: String(entry.name ?? entry.value ?? ""),
      });
    }
  }
  return out;
}

export function normalizeConfigOptions(raw: unknown): ConfigOptionView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => o as Record<string, unknown>)
    .filter((o) => o && typeof o === "object" && o.id !== undefined)
    .map((o) => ({
      id: String(o.id),
      name: String(o.name ?? o.id),
      description:
        typeof o.description === "string" ? o.description : undefined,
      category: typeof o.category === "string" ? o.category : undefined,
      type: typeof o.type === "string" ? o.type : "unknown",
      currentValue: o.currentValue,
      options: flattenChoices(o.options),
    }));
}

/** The config option that picks the model, when the agent exposes one. */
export function modelConfigOption(
  options: ConfigOptionView[],
): ConfigOptionView | null {
  return (
    options.find((o) => o.category === "model") ??
    options.find(
      (o) => o.type === "select" && /model/i.test(`${o.id} ${o.name}`),
    ) ??
    null
  );
}

export function configValueLabel(option: ConfigOptionView | null): string {
  if (!option) return "";
  const current =
    typeof option.currentValue === "string"
      ? option.currentValue
      : ((option.currentValue as { value?: unknown })?.value ?? null);
  const hit = option.options.find((o) => o.value === current);
  return hit?.name ?? (current != null ? String(current) : "");
}

function diffCountInItems(items: ThreadItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== "tool") continue;
    for (const c of item.call.content) {
      if (c.type === "diff") count += 1;
    }
  }
  return count;
}

/** Apply one raw `update` object onto the thread state (in place). */
export function applyUpdate(s: ThreadState, update: unknown): void {
  const u = update as Record<string, unknown> | null;
  const kind = u?.sessionUpdate;
  switch (kind) {
    case "user_message_chunk":
      appendStreamText(s, "user", u?.content);
      return;
    case "agent_message_chunk":
      appendStreamText(s, "agent", u?.content);
      return;
    case "agent_thought_chunk":
      appendStreamText(s, "thought", u?.content);
      return;
    case "tool_call":
    case "tool_call_update":
      upsertToolCall(s, u as Record<string, unknown>);
      return;
    case "plan": {
      sealStreams(s);
      const entries = normalizePlanEntries(u?.entries);
      const last = lastItem(s);
      if (last && last.kind === "plan") {
        last.entries = entries;
        last.time = Date.now();
      } else {
        s.items.push({
          kind: "plan",
          id: nextItemId(),
          entries,
          time: Date.now(),
        });
      }
      return;
    }
    case "available_commands_update":
      s.availableCommands = Array.isArray(u?.availableCommands)
        ? (u!.availableCommands as Record<string, unknown>[]).map((c) => ({
            name: String(c?.name ?? ""),
            description:
              typeof c?.description === "string" ? c.description : undefined,
          }))
        : [];
      return;
    case "usage_update":
      s.usage = {
        used: Number(u?.used ?? 0),
        size: Number(u?.size ?? 0),
      };
      return;
    case "config_option_update":
      s.configOptions = normalizeConfigOptions(u?.configOptions);
      return;
    case "current_mode_update":
      s.currentModeId = String(u?.currentModeId ?? "");
      for (const option of s.configOptions) {
        if (option.category === "mode") option.currentValue = s.currentModeId;
      }
      return;
    case "session_info_update": {
      const title = u?.title;
      if (typeof title === "string" && title.trim()) {
        s.title = title;
        s.metaDirty = true;
      }
      return;
    }
    default:
      // Unknown sessionUpdate kinds (including extension/_meta payloads)
      // are kept, not dropped: render as a collapsed raw block.
      pushRaw(s, update);
  }
}

/** `{kind:"turnEnd"}` — settle the round and report whether a queued
 *  prompt should be flushed next. */
export function applyTurnEnd(
  s: ThreadState,
  event: { stopReason?: string; error?: string },
): void {
  s.running = false;
  sealStreams(s);
  const status = event.error
    ? "failed"
    : event.stopReason === "cancelled"
      ? "stopped"
      : "done";
  s.items.push({
    kind: "settled",
    id: nextItemId(),
    status,
    stopReason: event.stopReason,
    error: event.error,
    diffCount: diffCountInItems(s.items.slice(s.roundItemBase)),
    artifactCount: roundArtifactCount(s),
    time: Date.now(),
  });
}

/** `{kind:"connectionLost"}` — honest unknown outcome, never "done". */
export function applyConnectionLost(s: ThreadState): void {
  s.connectionLost = true;
  s.pendingPermission = null;
  s.pendingElicitation = null;
  sealStreams(s);
  if (s.running) {
    s.running = false;
    s.items.push({
      kind: "settled",
      id: nextItemId(),
      status: "unknown",
      diffCount: diffCountInItems(s.items.slice(s.roundItemBase)),
      artifactCount: roundArtifactCount(s),
      time: Date.now(),
    });
  }
}

function applyPermissionRequest(
  s: ThreadState,
  event: {
    requestId: string;
    toolCall: unknown;
    options: unknown;
  },
): void {
  const toolCall = event.toolCall as Record<string, unknown> | null;
  if (toolCall && typeof toolCall === "object") {
    upsertToolCall(s, toolCall);
  }
  const options: PermissionOption[] = Array.isArray(event.options)
    ? (event.options as Record<string, unknown>[]).map((o) => ({
        optionId: String(o?.optionId ?? ""),
        name: String(o?.name ?? o?.optionId ?? ""),
        kind: String(o?.kind ?? ""),
      }))
    : [];
  const locations = normalizeLocations(toolCall?.locations);
  s.pendingPermission = {
    requestId: event.requestId,
    toolCallId:
      typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : null,
    title: String(toolCall?.title ?? ""),
    kind: String(toolCall?.kind ?? "other"),
    locations,
    options,
    decision: null,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ThreadsSnapshot {
  version: number;
  threads: Map<string, ThreadState>;
  index: IndexRow[];
  /** Agent-side sessions with no index row (`source: "agent"`). */
  agentRows: AgentOnlyRow[];
  /** `settings.autoArchiveDays` (0 = off). */
  autoArchiveDays: number;
}

/** Default auto-archive window when the setting is unset (days). */
export const DEFAULT_AUTO_ARCHIVE_DAYS = 30;

interface OpenInput {
  agentId: string;
  cwd: string;
  nativeSessionId?: string;
  configOptions?: Record<string, unknown> | null;
}

function titleFromBlocks(blocks: PromptBlock[]): string {
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 40);
}

class ThreadsStore {
  private threads = new Map<string, ThreadState>();
  private indexRows: IndexRow[] = [];
  private agentRows: AgentOnlyRow[] = [];
  private autoArchiveDays = 0;
  private listeners = new Set<() => void>();
  private snapshot: ThreadsSnapshot = {
    version: 0,
    threads: this.threads,
    index: this.indexRows,
    agentRows: this.agentRows,
    autoArchiveDays: this.autoArchiveDays,
  };
  /** channel kept alive per thread key. */
  private channels = new Map<string, Channel<unknown>>();
  /** dedupe concurrent opens (same agent+cwd+native target). */
  private openings = new Map<string, Promise<ThreadState>>();
  /** Unprompted ("draft") conversations per agent+cwd — re-picking the
   *  same pair reuses the draft instead of spawning another session. */
  private drafts = new Map<string, string>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ThreadsSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = {
      version: this.snapshot.version + 1,
      threads: this.threads,
      index: this.indexRows,
      agentRows: this.agentRows,
      autoArchiveDays: this.autoArchiveDays,
    };
    for (const fn of this.listeners) fn();
  }

  thread(key: string): ThreadState | undefined {
    return this.threads.get(key);
  }

  needsAttention(s: ThreadState): boolean {
    return (
      s.pendingPermission !== null ||
      s.pendingElicitation !== null ||
      (s.connectionLost && s.items.length > 0)
    );
  }

  async refreshIndex(): Promise<void> {
    try {
      this.indexRows = await invoke<IndexRow[]>("session_index_list");
    } catch {
      // Keep the last known index; a failed read must not blank the sidebar.
    }
    // Merge agent-side `session/list` for every known (agent, cwd) pair:
    // entries the agent reports but Farfold never indexed appear as
    // `source: "agent"` sidebar rows that resume on click.
    const pairs = new Map<string, { agentId: string; cwd: string }>();
    for (const row of this.indexRows) {
      pairs.set(`${row.agentId}${row.cwd}`, {
        agentId: row.agentId,
        cwd: row.cwd,
      });
    }
    const agentRows: AgentOnlyRow[] = [];
    await Promise.all(
      [...pairs.values()].map(async ({ agentId, cwd }) => {
        try {
          // `session_list` lazily connects — only call it when this
          // (agent, cwd) connection is already up, otherwise a passive
          // sidebar refresh would spawn agent processes (must not
          // auto-reconnect at startup).
          const statuses = await invoke<{ state: string; cwd: string }[]>(
            "agent_status",
            { agentId },
          );
          const live = statuses.some(
            (status) => status.state === "ready" && status.cwd === cwd,
          );
          if (!live) return;
          const entries = await invoke<SessionListEntry[]>("session_list", {
            agentId,
            cwd,
          });
          for (const entry of entries) {
            if (entry.source !== "agent" || entry.id !== null) continue;
            agentRows.push({
              key: `${agentId}:${cwd}:${entry.nativeSessionId}`,
              agentId,
              cwd,
              nativeSessionId: entry.nativeSessionId,
              title: entry.title,
              updatedAt: entry.updatedAt ?? 0,
            });
          }
        } catch {
          // No live connection for this pair — meta rows alone stand.
        }
      }),
    );
    this.agentRows = agentRows;
    try {
      const days = await invoke<unknown>("settings_get", {
        key: "autoArchiveDays",
      });
      this.autoArchiveDays =
        typeof days === "number" && days >= 0
          ? days
          : DEFAULT_AUTO_ARCHIVE_DAYS;
    } catch {
      this.autoArchiveDays = DEFAULT_AUTO_ARCHIVE_DAYS;
    }
    this.emit();
  }

  private applyChannelEvent(key: string, event: unknown): void {
    const s = this.threads.get(key);
    if (!s || !event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;
    if (e.kind === "permissionRequest") {
      applyPermissionRequest(s, {
        requestId: String(e.requestId ?? ""),
        toolCall: e.toolCall,
        options: e.options,
      });
    } else if (e.kind === "turnEnd") {
      applyTurnEnd(s, {
        stopReason: typeof e.stopReason === "string" ? e.stopReason : undefined,
        error: typeof e.error === "string" ? e.error : undefined,
      });
      const next = s.queued.shift();
      this.emit();
      if (next) void this.send(key, next);
      void this.refreshIndex();
      return;
    } else if (e.kind === "connectionLost") {
      applyConnectionLost(s);
      this.channels.delete(key);
      this.dropQueued(s);
    } else if (e.kind === "terminalOutput") {
      applyTerminalOutput(s, e);
    } else if (e.kind === "artifact") {
      const artifact = normalizeArtifact(e.artifact);
      if (artifact) s.artifacts.push(artifact);
    } else if (e.kind === "elicitation") {
      applyElicitation(s, e);
    } else if (e.kind === "notification") {
      pushRaw(s, { method: e.method, params: e.params }, "notification");
    } else if (e.update !== undefined) {
      applyUpdate(s, e.update);
      if (s.metaDirty) {
        s.metaDirty = false;
        void invoke("session_touch", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
          title: s.title,
          configOptions: null,
        })
          .then(() => this.refreshIndex())
          .catch(() => undefined);
      }
    }
    this.emit();
  }

  /** Open (or resume) a conversation. Safe to call twice — concurrent
   *  opens for the same target share one request. */
  open(input: OpenInput): Promise<ThreadState> {
    if (input.nativeSessionId) {
      const key = `${input.agentId}:${input.cwd}:${input.nativeSessionId}`;
      const existing = this.threads.get(key);
      if (existing && !existing.openError && !existing.connectionLost) {
        return Promise.resolve(existing);
      }
      if (existing?.connectionLost) {
        // Dead channel: drop the stale state; the re-open replays history.
        this.threads.delete(key);
        this.channels.delete(key);
      }
    } else {
      const draftKey = this.drafts.get(`${input.agentId}|${input.cwd}`);
      const draft = draftKey ? this.threads.get(draftKey) : undefined;
      if (draft && !draft.prompted && !draft.openError) {
        return Promise.resolve(draft);
      }
    }
    const openingKey = `${input.agentId} ${input.cwd} ${input.nativeSessionId ?? "-"}`;
    const pending = this.openings.get(openingKey);
    if (pending) return pending;

    const promise = (async (): Promise<ThreadState> => {
      const channel = new Channel<unknown>();
      const buffered: unknown[] = [];
      let boundKey: string | null = null;
      channel.onmessage = (event) => {
        if (boundKey) this.applyChannelEvent(boundKey, event);
        else buffered.push(event);
      };
      const result = await invoke<OpenResult>("session_open", {
        agentId: input.agentId,
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId ?? null,
        configOptions: input.configOptions ?? null,
        channel,
      });
      // The backend returns the canonicalized cwd (/tmp → /private/tmp):
      // the session key must be built from it — the index row the first
      // prompt will create uses the same canonical path.
      const key = `${input.agentId}:${result.cwd}:${result.nativeSessionId}`;
      const canonicalCwd = result.cwd;
      const rows = await invoke<IndexRow[]>("session_index_list").catch(
        () => null,
      );
      if (rows) this.indexRows = rows;
      const existing = this.threads.get(key);
      if (existing) {
        // Second open for the same live session: reuse state, swap channel.
        this.channels.set(key, channel);
        boundKey = key;
        for (const event of buffered.splice(0)) {
          this.applyChannelEvent(key, event);
        }
        this.emit();
        return existing;
      }
      const state = freshThreadState(
        key,
        input.agentId,
        canonicalCwd,
        result.nativeSessionId,
      );
      state.resumed = result.resumed;
      state.configOptions = normalizeConfigOptions(result.configOptions);
      this.threads.set(key, state);
      this.channels.set(key, channel);
      if (!result.resumed) {
        this.drafts.set(`${input.agentId}|${input.cwd}`, key);
      }
      boundKey = key;
      for (const event of buffered.splice(0)) {
        this.applyChannelEvent(key, event);
      }
      this.emit();
      void this.refreshIndex();
      return state;
    })().finally(() => {
      this.openings.delete(openingKey);
    });
    this.openings.set(openingKey, promise);
    return promise;
  }

  /** Resume failed state placeholder so the view can explain itself.
   *  `unrecoverable` marks restart-resume failures (PRODUCT.md §7:
   *  「无法恢复」而不是空会话). */
  markOpenFailed(
    key: string,
    agentId: string,
    cwd: string,
    nativeSessionId: string,
    error: string,
    unrecoverable = false,
  ): ThreadState {
    const state = freshThreadState(key, agentId, cwd, nativeSessionId);
    state.openError = error;
    state.unrecoverable = unrecoverable;
    this.threads.set(key, state);
    this.emit();
    return state;
  }

  /** Materialize the index row for an agent-side session (rename / pin /
   *  archive on a `source: "agent"` row) — `session_touch` upserts so the
   *  meta op that follows has a row to mutate. */
  async ensureIndexRow(input: {
    agentId: string;
    cwd: string;
    nativeSessionId: string;
    title?: string | null;
  }): Promise<void> {
    await invoke("session_touch", {
      agentId: input.agentId,
      cwd: input.cwd,
      sessionId: input.nativeSessionId,
      title: input.title ?? null,
      configOptions: null,
    });
    await this.refreshIndex();
  }

  /** Send a prompt; while running the prompt is queued and flushed by
   *  the next `turnEnd`. */
  async send(key: string, blocks: PromptBlock[]): Promise<void> {
    const s = this.threads.get(key);
    if (!s || blocks.length === 0) return;
    if (s.connectionLost) {
      s.items.push({
        kind: "settled",
        id: nextItemId(),
        status: "failed",
        error: STRINGS.thread.sendAfterLoss,
        diffCount: 0,
        artifactCount: 0,
        time: Date.now(),
      });
      this.emit();
      return;
    }
    if (s.running) {
      s.queued.push(blocks);
      this.emit();
      return;
    }
    sealStreams(s);
    const attachments: Attachment[] = blocks
      .filter((b) => b.type === "resource_link" || b.type === "image")
      .map((b) => ({
        name: b.type === "image" ? "image" : (b as { name: string }).name,
        uri:
          b.type === "resource_link" ? (b as { uri: string }).uri : undefined,
        mimeType:
          b.type === "image" ? (b as { mimeType: string }).mimeType : undefined,
      }));
    s.items.push({
      kind: "user",
      id: nextItemId(),
      text: titleFromBlocks(blocks) || "",
      attachments,
      streaming: false,
      time: Date.now(),
    });
    // Keep the full text, not just the 40-char title slice.
    const fullText = blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const userItem = s.items[s.items.length - 1];
    if (userItem.kind === "user") userItem.text = fullText;
    s.running = true;
    s.roundItemBase = s.items.length;
    s.roundArtifactBase = s.artifacts.length;
    const firstPrompt = !s.prompted;
    s.prompted = true;
    if (firstPrompt) {
      // The draft is now a real conversation; a fresh new-session open
      // for the same pair must not resurrect it.
      this.drafts.delete(`${s.agentId}|${s.cwd}`);
    }
    this.emit();
    const promptResult = invoke("session_prompt", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
      content: blocks,
    });
    if (firstPrompt) {
      // Set the row title in parallel so the sidebar updates while the
      // round is still running.
      const title = titleFromBlocks(blocks);
      if (title) {
        s.title = title;
        void invoke("session_touch", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
          title,
          configOptions: null,
        })
          .then(() => this.refreshIndex())
          .catch(() => undefined);
      }
    }
    try {
      await promptResult;
      void this.refreshIndex();
    } catch (error) {
      s.running = false;
      s.items.push({
        kind: "settled",
        id: nextItemId(),
        status: "failed",
        error: String(error),
        diffCount: 0,
        artifactCount: 0,
        time: Date.now(),
      });
      this.dropQueued(s);
      this.emit();
    }
  }

  /** Queued prompts can never flush once the round is dead (no turnEnd
   *  will arrive): surface them as dropped instead of a stuck「已排队」. */
  private dropQueued(s: ThreadState): void {
    if (s.queued.length === 0) return;
    const dropped = s.queued.length;
    s.queued = [];
    s.items.push({
      kind: "settled",
      id: nextItemId(),
      status: "failed",
      error: STRINGS.thread.queuedDropped(dropped),
      diffCount: 0,
      artifactCount: 0,
      time: Date.now(),
    });
  }

  dequeue(key: string, index: number): void {
    const s = this.threads.get(key);
    if (!s) return;
    s.queued.splice(index, 1);
    this.emit();
  }

  async cancel(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (!s || !s.running) return;
    s.queued = [];
    this.emit();
    try {
      await invoke("session_cancel", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
      });
    } catch (error) {
      s.items.push({
        kind: "settled",
        id: nextItemId(),
        status: "failed",
        error: String(error),
        diffCount: 0,
        artifactCount: 0,
        time: Date.now(),
      });
      this.emit();
    }
    // "停止中…" until turnEnd settles the round — do not flip running here.
  }

  /** `allow_always` gets a 5s undo window (the response is held so the
   *  "remember" can be reverted); once-off decisions respond immediately —
   *  there is nothing to undo after the action already ran. */
  decidePermission(
    key: string,
    optionId: string,
    label: string,
    allow: boolean,
    remember = false,
  ): void {
    const s = this.threads.get(key);
    const permission = s?.pendingPermission;
    if (!s || !permission) return;
    permission.decision = { optionId, label, allow, undoable: remember };
    this.emit();
    const requestId = permission.requestId;
    setTimeout(
      () => {
        void this.flushPermissionDecision(key, requestId);
      },
      remember ? 5000 : 0,
    );
  }

  undoPermissionDecision(key: string): void {
    const s = this.threads.get(key);
    if (!s?.pendingPermission?.decision) return;
    s.pendingPermission.decision = null;
    this.emit();
  }

  private async flushPermissionDecision(
    key: string,
    requestId: string,
  ): Promise<void> {
    const s = this.threads.get(key);
    const permission = s?.pendingPermission;
    if (!s || !permission || permission.requestId !== requestId) return;
    const decision = permission.decision;
    if (!decision) return; // undone meanwhile
    try {
      await invoke("session_permission_respond", {
        requestId,
        optionId: decision.optionId,
      });
      if (s.pendingPermission?.requestId === requestId) {
        s.pendingPermission = null;
      }
      // Leave a transcript record of the decision — the card is gone.
      s.items.push({
        kind: "decision",
        id: nextItemId(),
        label: decision.label,
        allow: decision.allow,
        time: Date.now(),
      });
    } catch (error) {
      // Response failed (connection died / request gone): keep the card
      // visible with the error instead of pretending it was answered.
      permission.decision = null;
      s.items.push({
        kind: "settled",
        id: nextItemId(),
        status: "failed",
        error: String(error),
        diffCount: 0,
        artifactCount: 0,
        time: Date.now(),
      });
    }
    this.emit();
  }

  /** Open the artifact drawer; hydrates the backend's memory-only list
   *  once so artifacts from before a UI reload still appear. */
  async openArtifactPane(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (!s) return;
    s.artifactPaneOpen = true;
    this.emit();
    if (!s.artifactsHydrated) {
      s.artifactsHydrated = true;
      try {
        const rows = await invoke<unknown[]>("session_artifacts", {
          agentId: s.agentId,
          cwd: s.cwd,
          sessionId: s.nativeSessionId,
        });
        // The backend list is authoritative and contains every artifact
        // already streamed on the channel — replace, never merge.
        s.artifacts = rows
          .map(normalizeArtifact)
          .filter((a): a is ArtifactView => a !== null);
      } catch {
        // A dead connection has no artifact list; live channel artifacts
        // already in state remain the honest view.
      }
      this.emit();
    }
  }

  closeArtifactPane(key: string): void {
    const s = this.threads.get(key);
    if (!s) return;
    s.artifactPaneOpen = false;
    this.emit();
  }

  /** Answer a pending `elicitation/create` form: `accept` carries the
   *  submitted values, `cancel`/`decline` carry none. */
  async respondElicitation(
    key: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ): Promise<void> {
    const s = this.threads.get(key);
    const elicitation = s?.pendingElicitation;
    if (!s || !elicitation) return;
    const requestId = elicitation.requestId;
    s.pendingElicitation = null;
    this.emit();
    try {
      await invoke("session_elicitation_respond", {
        requestId,
        action,
        content: action === "accept" ? (values ?? {}) : null,
      });
    } catch (error) {
      s.items.push({
        kind: "settled",
        id: nextItemId(),
        status: "failed",
        error: String(error),
        diffCount: 0,
        artifactCount: 0,
        time: Date.now(),
      });
      this.emit();
    }
  }

  async setConfig(
    key: string,
    configId: string,
    value: unknown,
  ): Promise<void> {
    const s = this.threads.get(key);
    if (!s) return;
    const updated = await invoke<unknown>("session_set_config", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
      configId,
      value,
    });
    s.configOptions = normalizeConfigOptions(updated);
    this.emit();
  }

  /** Re-open after a lost connection: fresh state, replayed history. */
  async reconnect(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (!s) return;
    this.channels.delete(key);
    this.threads.delete(key);
    this.emit();
    await this.open({
      agentId: s.agentId,
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
    });
  }

  async close(key: string): Promise<void> {
    const s = this.threads.get(key);
    this.channels.delete(key);
    this.threads.delete(key);
    if (s) this.drafts.delete(`${s.agentId}|${s.cwd}`);
    this.emit();
    if (!s) return;
    await invoke("session_close", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
    }).catch(() => undefined);
  }

  // ---- index metadata ops ----

  async rename(rowId: string, title: string): Promise<void> {
    const row = await invoke<IndexRow>("session_meta_rename", {
      sessionId: rowId,
      title,
    });
    const s = this.threads.get(rowId);
    if (s) s.title = row.title;
    await this.refreshIndex();
  }

  async setPinned(rowId: string, pinned: boolean): Promise<void> {
    await invoke("session_meta_pin", { sessionId: rowId, pinned });
    await this.refreshIndex();
  }

  async setArchived(rowId: string, archived: boolean): Promise<void> {
    await invoke("session_meta_archive", { sessionId: rowId, archived });
    await this.refreshIndex();
  }

  /** Discard an unprompted draft: close the agent session and tombstone it
   *  so `session/list` cannot resurface it as an agent-side row. */
  async discardDraft(key: string): Promise<void> {
    const s = this.threads.get(key);
    if (!s || s.prompted) return;
    this.threads.delete(key);
    this.channels.delete(key);
    this.drafts.delete(`${s.agentId}|${s.cwd}`);
    this.emit();
    await invoke("session_close", {
      agentId: s.agentId,
      cwd: s.cwd,
      sessionId: s.nativeSessionId,
    }).catch(() => undefined);
    await invoke("session_dismiss", {
      agentId: s.agentId,
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
    }).catch(() => undefined);
  }

  /** Delete a session — agent-side `session/delete` when supported, index
   *  row removal, and a tombstone so it cannot reappear. Works for both
   *  meta rows (`source:"meta"`) and agent-side rows (`source:"agent"`). */
  async delete(row: {
    id?: string;
    key?: string;
    agentId: string;
    cwd: string;
    nativeSessionId: string | null;
  }): Promise<void> {
    const native = row.nativeSessionId;
    if (!native) return;
    const key = row.id ?? row.key ?? `${row.agentId}:${row.cwd}:${native}`;
    const s = this.threads.get(key);
    this.threads.delete(key);
    if (s) this.drafts.delete(`${s.agentId}|${s.cwd}`);
    this.channels.delete(key);
    this.emit();
    if (s) {
      await invoke("session_close", {
        agentId: s.agentId,
        cwd: s.cwd,
        sessionId: s.nativeSessionId,
      }).catch(() => undefined);
    }
    await invoke("session_delete", {
      agentId: row.agentId,
      cwd: row.cwd,
      nativeSessionId: native,
    }).catch(() => undefined);
    await this.refreshIndex();
  }
}

export const threads = new ThreadsStore();

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

export function useThreadsSnapshot(): ThreadsSnapshot {
  return useSyncExternalStore(threads.subscribe, threads.getSnapshot);
}

export function useThread(key: string | null | undefined): ThreadState | null {
  const snap = useThreadsSnapshot();
  return key ? (snap.threads.get(key) ?? null) : null;
}

// Re-exported for existing `../runtime/sessions` imports; the sidebar
// view-model helpers now live in `runtime/sidebar.ts`.
export { basename, groupSidebarRows, relativeTime, shortPath } from "./sidebar";
export type { SidebarRow } from "./sidebar";
