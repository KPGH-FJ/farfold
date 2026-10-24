// In-memory projection of ordered protocol events. No persistence or transport.
import { roundArtifactCount } from "./artifacts";
import { hasAsyncTasks, isKnownAsyncTaskUpdate } from "./async_tasks";
import { readElicitation } from "./elicitation";
import { INQUIRY } from "./elicitation_strings";
import {
  hasActiveCompaction,
  unconfirmedCompactionOutcome,
} from "./compaction_activity";
import {
  applyCompaction,
  loseCompactionObservation,
  maintenanceResult,
} from "./compaction";
import {
  completion,
  canContinueAfterCompletion,
  type CompletionEvent,
} from "./completion";
import { hasAgentReply, roundResult, type RoundResult } from "./round_result";
import { pauseQueue } from "./queue";
import { forgetConfigurationPause } from "./configuration_pause";
import { connectionCloseReason } from "./connection_close";
import { STRINGS } from "./strings";
import { reportedTokens, reportedUsage } from "./session_usage";
import {
  normalizeMessageAttachment,
  sameOfficialAttachment,
} from "./message_attachments";
import { streamTailItem } from "./session_streams";
import { appendMessageContentPart } from "./message_content_order";
import { retainReportedDetails } from "./reported_details";
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
    activeToolCallIds: [],
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
    pendingElicitations: [],
    artifactPaneOpen: false,
    artifactPaneTarget: null,
    artifactPaneSelection: null,
    roundItemBase: 0,
    configOptions: [],
    permissionState: "ready",
    usage: null,
    sessionTokens: null,
    availableCommands: [],
    currentModeId: null,
    modesSeparate: false,
    modelDrift: false,
    configCheck: null,
    connectionLost: false,
    connectionOutcomeUnknown: false,
    historicalOutcomeUnknown: false,
    resumed: false,
    openError: null,
    historyUnavailable: null,
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

function appendRaw(
  s: ThreadState,
  update: unknown,
  label?: string,
  streamNeutral = false,
): void {
  s.items.push({
    kind: "raw",
    id: nextItemId(),
    update,
    label,
    ...(streamNeutral ? { streamNeutral: true as const } : {}),
    time: Date.now(),
  });
}

export function pushRaw(s: ThreadState, update: unknown, label?: string): void {
  sealStreams(s);
  appendRaw(s, update, label);
}

/** Out-of-band notifications are retained without declaring a message boundary. */
export function pushNotification(s: ThreadState, update: unknown): void {
  appendRaw(s, update, "notification", true);
}

function appendStreamText(
  s: ThreadState,
  kind: "user" | "agent" | "thought",
  content: unknown,
  declaredMessageId?: unknown,
): void {
  const messageId =
    typeof declaredMessageId === "string" ? declaredMessageId : undefined;
  const tail = streamTailItem(s.items);
  const last = lastItem(s);
  // The current optimistic user message has not yet been assigned an Agent
  // ID. Historical text similarity alone cannot identify an echo when the
  // Agent has supplied an explicit, different message boundary.
  const optimisticEcho =
    kind === "user" &&
    last?.kind === "user" &&
    !last.streaming &&
    s.running &&
    s.roundItemBase === s.items.length &&
    (last.messageId === undefined || last.messageId === messageId);
  const sameMessage =
    tail?.kind === kind &&
    (messageId === undefined || tail.messageId === messageId) &&
    (tail.streaming || (messageId !== undefined && !optimisticEcho));
  const text = textOf(content);
  if (text === null) {
    const attachment =
      kind === "thought" ? null : normalizeMessageAttachment(content);
    if (attachment && kind !== "thought") {
      if (sameMessage && (tail.kind === "user" || tail.kind === "agent")) {
        const start = tail.attachments?.length ?? 0;
        tail.attachments = [...(tail.attachments ?? []), attachment];
        if (tail.kind === "agent")
          tail.contentOrder = appendMessageContentPart(tail.contentOrder, {
            kind: "attachments",
            start,
            end: start + 1,
          });
        tail.streaming = true;
        return;
      }
      if (
        last?.kind === kind &&
        (last.kind === "user" || last.kind === "agent")
      ) {
        // Exact echoed attachments can refer to our already-visible optimistic
        // message. Never infer identity from a filename or media type alone.
        const duplicate =
          !last.streaming &&
          kind === "user" &&
          (messageId === undefined || optimisticEcho) &&
          last.attachments?.some((existing) =>
            sameOfficialAttachment(existing, attachment),
          );
        if (duplicate) {
          if (messageId !== undefined) last.messageId = messageId;
          return;
        }
      }
      sealStreams(s);
      s.items.push({
        kind,
        id: nextItemId(),
        ...(messageId === undefined ? {} : { messageId }),
        text: "",
        attachments: [attachment],
        ...(kind === "agent"
          ? {
              contentOrder: [
                { kind: "attachments" as const, start: 0, end: 1 },
              ],
            }
          : {}),
        streaming: true,
        time: Date.now(),
      });
      return;
    }
    pushRaw(s, content ?? {});
    return;
  }
  if (sameMessage) {
    if (tail.kind === "agent")
      tail.contentOrder = appendMessageContentPart(tail.contentOrder, {
        kind: "text",
        start: tail.text.length,
        end: tail.text.length + text.length,
      });
    tail.text += text;
    tail.streaming = true;
    return;
  }
  // Echo de-dup: a live agent may replay the user's message we already
  // rendered optimistically; skip chunks fully contained in it.
  if (
    kind === "user" &&
    last &&
    last.kind === "user" &&
    (messageId === undefined || optimisticEcho) &&
    last.text.includes(text)
  ) {
    if (messageId !== undefined) last.messageId = messageId;
    return;
  }
  if (kind !== "user" || messageId !== undefined) sealStreams(s);
  s.items.push({
    kind,
    id: nextItemId(),
    ...(messageId === undefined ? {} : { messageId }),
    text,
    ...(kind === "agent"
      ? {
          contentOrder: text
            ? [{ kind: "text" as const, start: 0, end: text.length }]
            : [],
        }
      : {}),
    streaming: true,
    time: Date.now(),
    ...(kind === "user" ? { attachments: [] } : {}),
  } as ThreadItem);
}

function normalizeLocations(raw: unknown): ToolLocation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((loc) => typeof loc?.path === "string")
    .map((loc) => ({
      path: (loc as { path: string }).path,
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
      if (typeof c.path !== "string") return { type: "raw", value: raw };
      return {
        type: "diff",
        path: c.path,
        oldText: typeof c.oldText === "string" ? c.oldText : null,
        newText: String(c.newText ?? ""),
      };
    case "terminal":
      return { type: "terminal", terminalId: String(c.terminalId ?? "") };
    case "content": {
      const inner = c.content as Record<string, unknown> | null;
      if (inner?.type === "text" && typeof inner.text === "string") {
        return { type: "text", text: inner.text };
      }
      const attachment = normalizeMessageAttachment(inner);
      if (attachment?.kind === "resource_link" && attachment.uri) {
        return {
          type: "link",
          name: attachment.name,
          uri: attachment.uri,
        };
      }
      if (attachment) return { type: "attachment", attachment };
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

function upsertToolCall(
  s: ThreadState,
  update: Record<string, unknown>,
): ToolCallView | undefined {
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
          startedAt:
            update.status === "completed" || update.status === "failed"
              ? 0
              : Date.now(),
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
  // ACP v1 nullable optional fields treat null like omission. Explicit []
  // still replaces a collection; v2's null-clearing rule does not apply here.
  if (update.locations !== undefined && update.locations !== null) {
    call.locations = normalizeLocations(update.locations);
  }
  if (update.content !== undefined && update.content !== null) {
    call.content = normalizeToolContents(update.content);
  }
  if (update.rawInput !== undefined && update.rawInput !== null)
    call.rawInput = update.rawInput;
  if (update.rawOutput !== undefined && update.rawOutput !== null)
    call.rawOutput = update.rawOutput;
  if (
    (call.status === "completed" || call.status === "failed") &&
    call.startedAt > 0 &&
    call.endedAt === undefined
  ) {
    call.endedAt = Date.now();
  }
  if (index < 0) {
    s.items.push({ kind: "tool", id: nextItemId(), call });
  }
  return call;
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
          description:
            typeof opt?.description === "string" ? opt.description : undefined,
        });
      }
    } else if (entry && typeof entry === "object") {
      out.push({
        value: String(entry.value ?? ""),
        name: String(entry.name ?? entry.value ?? ""),
        description:
          typeof entry.description === "string" ? entry.description : undefined,
      });
    }
  }
  return out;
}

function knownConfigFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

function optionalConfigLabel(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function knownConfigChoice(value: unknown): boolean {
  return (
    knownConfigFields(value, ["value", "name", "description"]) &&
    typeof value.value === "string" &&
    typeof value.name === "string" &&
    optionalConfigLabel(value.description)
  );
}

function knownConfigGroup(value: unknown): boolean {
  return (
    knownConfigFields(value, ["group", "name", "options"]) &&
    typeof value.group === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.options) &&
    value.options.every(knownConfigChoice)
  );
}

/** Recognition only: raw updates never confirm or save configuration choices. */
export function isKnownConfigUpdate(update: unknown): boolean {
  if (
    !knownConfigFields(update, ["sessionUpdate", "configOptions"]) ||
    update.sessionUpdate !== "config_option_update" ||
    !Array.isArray(update.configOptions)
  )
    return false;
  return update.configOptions.every((option) => {
    if (
      !knownConfigFields(option, [
        "id",
        "name",
        "description",
        "category",
        "type",
        "currentValue",
        "options",
      ]) ||
      typeof option.id !== "string" ||
      typeof option.name !== "string" ||
      !optionalConfigLabel(option.description) ||
      !optionalConfigLabel(option.category)
    )
      return false;
    if (option.type === "boolean")
      return (
        typeof option.currentValue === "boolean" &&
        !Object.hasOwn(option, "options")
      );
    return (
      option.type === "select" &&
      typeof option.currentValue === "string" &&
      Array.isArray(option.options) &&
      (option.options.every(knownConfigChoice) ||
        option.options.every(knownConfigGroup))
    );
  });
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
  const declared = options.filter((option) => option.category === "model");
  if (declared.length === 1) return declared[0]!;
  if (declared.length > 1) {
    // A category can contain both the provider and the concrete model. Preserve
    // every option; choose the main model control only when it is unambiguous.
    const byId = declared.filter(
      (option) => option.id.toLowerCase() === "model",
    );
    if (byId.length) return byId.length === 1 ? byId[0]! : null;
    const byName = declared.filter(
      (option) => option.name.toLowerCase() === "model",
    );
    return byName.length === 1 ? byName[0]! : null;
  }
  return (
    options.find(
      (o) => o.type === "select" && /model/i.test(`${o.id} ${o.name}`),
    ) ?? null
  );
}

/** Only a legacy-only declaration may produce the older mode control. */
export function synthesizeModeOption(
  modes: unknown,
  modern = false,
): ConfigOptionView | null {
  if (modern) return null;
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

/** Read the requested model ID from current or legacy index metadata. */
export function storedModelValue(
  stored: unknown,
  optionId: string | null,
): string | null {
  if (!optionId || !stored || typeof stored !== "object") return null;
  const record = stored as Record<string, unknown>;
  if (record._farfoldConfig === 2) {
    if (!Array.isArray(record.choices)) return null;
    const matches = record.choices.filter(
      (choice) =>
        choice && typeof choice === "object" && choice.id === optionId,
    );
    if (matches.length !== 1) return null;
    const choice = matches[0];
    return choice.category === "model" &&
      choice.type === "select" &&
      typeof choice.value === "string"
      ? choice.value
      : null;
  }
  if (record._farfoldConfig === 1) {
    const model = record.model as { id?: unknown; value?: unknown } | null;
    return model?.id === optionId && typeof model.value === "string"
      ? model.value
      : null;
  }
  const value = record[optionId];
  return value == null ? null : String(value);
}

export function configValueLabel(option: ConfigOptionView | null): string {
  if (!option) return "";
  if (typeof option.currentValue === "boolean")
    return option.currentValue
      ? STRINGS.options.enabled
      : STRINGS.options.disabled;
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
export function applyUpdate(
  s: ThreadState,
  update: unknown,
  envelope?: unknown,
): void {
  let projectedTool: ToolCallView | undefined;
  if (isKnownAsyncTaskUpdate(s, update, envelope))
    pushRaw(s, update, "asyncTaskUpdate");
  else projectedTool = applyUpdateContent(s, update);
  retainReportedDetails(s, update, envelope, projectedTool);
}

function applyUpdateContent(
  s: ThreadState,
  update: unknown,
): ToolCallView | undefined {
  const u = update as Record<string, unknown> | null;
  const kind = u?.sessionUpdate;
  switch (kind) {
    case "compaction_update":
    case "compaction_summary_chunk":
      if (!applyCompaction(s.items, u!, nextItemId)) pushRaw(s, update);
      return;
    case "user_message_chunk":
      appendStreamText(s, "user", u?.content, u?.messageId);
      return;
    case "agent_message_chunk":
      appendStreamText(s, "agent", u?.content, u?.messageId);
      return;
    case "agent_thought_chunk":
      appendStreamText(s, "thought", u?.content, u?.messageId);
      return;
    case "tool_call":
    case "tool_call_update":
      return upsertToolCall(s, u as Record<string, unknown>);
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
        ? (u!.availableCommands as Record<string, unknown>[]).map((c) => {
            const input = c?.input as { hint?: unknown } | null;
            return {
              name: String(c?.name ?? ""),
              description:
                typeof c?.description === "string" ? c.description : undefined,
              ...(input &&
              !Array.isArray(input) &&
              typeof input.hint === "string" &&
              input.hint.trim()
                ? { input: { hint: input.hint } }
                : {}),
            };
          })
        : [];
      return;
    case "usage_update":
      s.usage = reportedUsage(u);
      return;
    case "config_option_update":
      replaceConfigOptions(s, normalizeConfigOptions(u?.configOptions));
      return;
    case "current_mode_update":
      if (!s.modesSeparate) return;
      s.currentModeId = String(u?.currentModeId ?? "");
      for (const option of s.configOptions) {
        if (option.category === "mode") option.currentValue = s.currentModeId;
      }
      return;
    case "session_info_update": {
      const title = u?.title;
      // Agent metadata may fill an unnamed conversation, but cannot replace
      // a Farfold title (including a user rename replayed after cold restore).
      if (!s.title?.trim() && typeof title === "string" && title.trim()) {
        s.title = title;
        s.metaDirty = true;
      }
      return;
    }
    default:
      // Unknown sessionUpdate kinds (including extension/_meta payloads)
      // are kept, not dropped: render as a collapsed raw block.
      pushRaw(s, update);
      return;
  }
}

/** A complete modern declaration supersedes the older modes surface. */
export function replaceConfigOptions(
  s: ThreadState,
  options: ConfigOptionView[],
  modern = true,
) {
  const separateMode =
    s.modesSeparate && !modern
      ? s.configOptions.find((option) => option.id === "mode")
      : undefined;
  const declaresMode = options.some(
    (option) => option.id === "mode" || option.category === "mode",
  );
  s.configOptions =
    separateMode && !declaresMode ? [...options, separateMode] : options;
  if (modern || declaresMode) s.modesSeparate = false;
}

/** `{kind:"turnEnd"}` — settle the round and report whether a queued
 *  prompt should be flushed next. */
export function applyTurnEnd(
  s: ThreadState,
  event: CompletionEvent,
): RoundResult {
  s.sessionTokens = reportedTokens(event.usage);
  s.running = false;
  s.stopping = false;
  s.stopUnconfirmed = false;
  s.connectionOutcomeUnknown = unconfirmedCompactionOutcome(s);
  clearPendingRequests(s);
  sealStreams(s);
  const { status, error } = completion(event);
  const round = s.items.slice(s.roundItemBase);
  const replyReceived = hasAgentReply(round);
  const compactions = round.flatMap((item) =>
    item.kind === "compaction" ? [item] : [],
  );
  const maintenance = maintenanceResult(compactions);
  const result = roundResult(
    replyReceived,
    round.flatMap((item) => (item.kind === "tool" ? [item.call] : [])),
    s.activeToolCallIds,
    !s.connectionLost,
    compactions,
  );
  if (
    !canContinueAfterCompletion(status, result) ||
    (maintenance && maintenance !== "maintenance")
  )
    pauseQueue(
      s,
      status === "unknown" || maintenance === "maintenance_unknown"
        ? "uncertain"
        : status === "done"
          ? maintenance === "maintenance_failed"
            ? "failed"
            : result === "pending" || maintenance
              ? "stopped"
              : "no_result"
          : status,
    );
  s.items.push({
    kind: "settled",
    id: nextItemId(),
    status,
    stopReason: event.stopReason,
    error,
    diffCount: diffCountInItems(s.items.slice(s.roundItemBase)),
    artifactCount: roundArtifactCount(s),
    artifactToolItemIds: roundToolItemIds(s),
    compactionItemIds: round.flatMap((item) =>
      item.kind === "compaction" ? [item.id] : [],
    ),
    replyReceived,
    time: Date.now(),
  });
  return result;
}

/** `{kind:"connectionLost"}` — honest unknown outcome, never "done". */
export function applyConnectionLost(s: ThreadState, reason?: unknown): void {
  loseCompactionObservation(s.items);
  forgetConfigurationPause(s);
  s.connectionOutcomeUnknown = Boolean(
    s.connectionOutcomeUnknown ||
    s.running ||
    s.submitting ||
    s.stopping ||
    s.stopUnconfirmed ||
    s.activeToolCallIds.length > 0 ||
    hasActiveCompaction(s) ||
    hasAsyncTasks(s) ||
    s.uncertainPrompt ||
    s.pendingPermissions.length ||
    s.pendingElicitations.length ||
    s.browserReadRequestId,
  );
  s.connectionLost = true;
  s.browserReadRequestId = null;
  s.connectionCloseReason = connectionCloseReason(reason);
  s.stopping = false;
  s.stopUnconfirmed = false;
  if (s.submitting && s.queued[0]) {
    s.uncertainPrompt = s.queued[0];
    s.identity = "established";
  }
  clearPendingRequests(s);
  sealStreams(s);
  if (s.running) {
    s.running = false;
    s.items.push({
      kind: "settled",
      id: nextItemId(),
      status: "unknown",
      diffCount: diffCountInItems(s.items.slice(s.roundItemBase)),
      artifactCount: roundArtifactCount(s),
      artifactToolItemIds: roundToolItemIds(s),
      time: Date.now(),
    });
  }
}

function roundToolItemIds(s: ThreadState): string[] {
  return s.items
    .slice(s.roundItemBase)
    .filter((item) => item.kind === "tool")
    .map((item) => item.id);
}

export function applyPermissionRequest(
  s: ThreadState,
  event: {
    requestId: string;
    toolCall: unknown;
    options: unknown;
    request?: unknown;
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
  s.pendingPermissions = [
    ...s.pendingPermissions,
    {
      requestId: event.requestId,
      status: "pending",
      error: null,
      toolCallId:
        typeof toolCall?.toolCallId === "string" ? toolCall.toolCallId : null,
      toolCallSnapshot:
        toolCall && typeof toolCall === "object" && !Array.isArray(toolCall)
          ? structuredClone(toolCall)
          : null,
      requestSnapshot: structuredClone(event.request),
      title: String(toolCall?.title ?? ""),
      kind: String(toolCall?.kind ?? "other"),
      locations,
      options,
      decision: null,
    },
  ];
}

export function applyElicitation(
  s: ThreadState,
  event: Record<string, unknown>,
): void {
  const requestId = String(event.requestId ?? "");
  if (
    !requestId ||
    s.pendingElicitations.some((p) => p.requestId === requestId)
  )
    return;
  const request = readElicitation(event);
  if (request) s.pendingElicitations = [...s.pendingElicitations, request];
}

export function completeElicitation(
  s: ThreadState,
  event: Record<string, unknown>,
): void {
  const id = String(event.requestId ?? "");
  if (
    !s.pendingElicitations.some((p) => p.requestId === id && p.mode === "url")
  )
    return;
  removePendingRequest(s, id);
  s.items.push({
    kind: "notice",
    id: nextItemId(),
    message: INQUIRY.complete,
    time: Date.now(),
  });
}

export function clearPendingRequests(s: ThreadState): void {
  s.pendingPermissions = [];
  s.pendingElicitations = [];
}

export function removePendingRequest(s: ThreadState, requestId: string): void {
  s.pendingPermissions = s.pendingPermissions.filter(
    (p) => p.requestId !== requestId,
  );
  s.pendingElicitations = s.pendingElicitations.filter(
    (p) => p.requestId !== requestId,
  );
}

export function expirePendingRequest(s: ThreadState, requestId: string): void {
  if (
    ![...s.pendingPermissions, ...s.pendingElicitations].some(
      (p) => p.requestId === requestId,
    )
  )
    return;
  removePendingRequest(s, requestId);
  s.items.push({
    kind: "notice",
    id: nextItemId(),
    message: STRINGS.repair.interactionExpired,
    time: Date.now(),
  });
}
