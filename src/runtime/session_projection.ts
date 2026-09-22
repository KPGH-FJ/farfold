// In-memory projection of ordered protocol events. No persistence or transport.
import { roundArtifactCount } from "./artifacts";
import { completion, type CompletionEvent } from "./completion";
import { pauseQueue } from "./queue";
import { STRINGS } from "./strings";
import type {
  ConfigChoice,
  ConfigOptionView,
  PermissionOption,
  PlanEntry,
  ThreadItem,
  ThreadState,
  ToolCallView,
  ToolContent,
  ToolLocation,
} from "./session_types";

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
    pendingPermissions: [],
    identity: "draft",
    reconnecting: false,
    submitting: false,
    configuring: false,
    configError: null,
    workEnabled: true,
    queuePaused: null,
    uncertainPrompt: null,
    stopping: false,
    stopUnconfirmed: false,
    pendingElicitation: null,
    artifactPaneOpen: false,
    roundItemBase: 0,
    configOptions: [],
    usage: null,
    availableCommands: [],
    currentModeId: null,
    modesSeparate: false,
    modelDrift: false,
    connectionLost: false,
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
export const nextItemId = () => `it-${++itemSeq}`;

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
export function sealStreams(s: ThreadState): void {
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

export function pushRaw(s: ThreadState, update: unknown, label?: string): void {
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

/** Agents that send a top-level `modes` object (not a configOptions
 *  entry) get a synthetic `category:"mode"` option so one menu covers
 *  every session-level switch. Returns null when no modes are sent. */
export function synthesizeModeOption(modes: unknown): ConfigOptionView | null {
  const m = modes as Record<string, unknown> | null;
  const list = m?.availableModes;
  if (!Array.isArray(list) || list.length === 0) return null;
  return {
    id: "mode",
    name: STRINGS.options.modeName,
    category: "mode",
    type: "select",
    currentValue: typeof m?.currentModeId === "string" ? m.currentModeId : null,
    options: list
      .map((mode) => mode as Record<string, unknown>)
      .filter((mode) => typeof mode?.id === "string")
      .map((mode) => ({
        value: String(mode.id),
        name: String(mode.name ?? mode.id),
      })),
  };
}

/** The model option's current value as a plain string (stored on the
 *  index row at creation, compared on resume to flag drift). */
export function modelValueOf(option: ConfigOptionView | null): string | null {
  if (!option) return null;
  const raw = option.currentValue;
  const value =
    typeof raw === "object" && raw !== null
      ? (raw as { value?: unknown }).value
      : raw;
  return value == null ? null : String(value);
}

/** `config_options` on an index row: `{configId: value}` — read the model
 *  entry written when the session was established. */
export function storedModelValue(
  stored: unknown,
  optionId: string | null,
): string | null {
  if (!optionId || !stored || typeof stored !== "object") return null;
  const value = (stored as Record<string, unknown>)[optionId];
  return value == null ? null : String(value);
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
export function applyTurnEnd(s: ThreadState, event: CompletionEvent): void {
  s.running = false;
  s.stopping = false;
  s.stopUnconfirmed = false;
  s.pendingPermissions = [];
  s.pendingElicitation = null;
  sealStreams(s);
  const { status, error } = completion(event);
  if (status !== "done")
    pauseQueue(s, status === "unknown" ? "uncertain" : status);
  s.items.push({
    kind: "settled",
    id: nextItemId(),
    status,
    stopReason: event.stopReason,
    error,
    diffCount: diffCountInItems(s.items.slice(s.roundItemBase)),
    artifactCount: roundArtifactCount(s),
    time: Date.now(),
  });
}

/** `{kind:"connectionLost"}` — honest unknown outcome, never "done". */
export function applyConnectionLost(s: ThreadState): void {
  s.connectionLost = true;
  s.stopping = false;
  s.stopUnconfirmed = false;
  if (s.submitting && s.queued[0]) {
    s.uncertainPrompt = s.queued[0];
    s.identity = "established";
  }
  s.pendingPermissions = [];
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

export function applyPermissionRequest(
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
  if (s.pendingPermissions.some((p) => p.requestId === event.requestId)) return;
  s.pendingPermissions.push({
    requestId: event.requestId,
    toolCallId:
      typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : null,
    title: String(toolCall?.title ?? ""),
    kind: String(toolCall?.kind ?? "other"),
    locations,
    options,
    decision: null,
  });
}
