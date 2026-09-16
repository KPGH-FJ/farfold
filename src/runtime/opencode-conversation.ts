import type {
  ConversationState,
  TimelineItem,
  ToolActivity,
  TranscriptItem,
} from "./conversation";
import type { OpenCodeEnvelope } from "./opencode";

type JsonObject = Record<string, unknown>;

export interface OpenCodePermissionRequest {
  id: string;
  sessionId: string;
  requestKind?: "permission" | "question";
  permission: string;
  patterns: string[];
  always: string[];
  metadata: JsonObject;
  options?: { optionId: string; name: string; kind: string }[];
  questionFields?: {
    id: string;
    title: string;
    multiple: boolean;
    customField: string | null;
    options: { label: string; description: string }[];
  }[];
  adapter?: "server" | "acp";
}

export interface OpenCodeConversationState extends ConversationState {
  permissions: OpenCodePermissionRequest[];
  unknownEventCount: number;
  retryDetail: string | null;
  outcomeUnknown: boolean;
  runtimeObserved: boolean;
  activeAcpMessageId: string | null;
  activeAcpUserMessageId: string | null;
  recoveryNotice?: string | null;
}

export const initialOpenCodeConversation: OpenCodeConversationState = {
  timeline: [],
  isWorking: false,
  steering: [],
  followUp: [],
  notice: null,
  permissions: [],
  unknownEventCount: 0,
  retryDetail: null,
  outcomeUnknown: false,
  runtimeObserved: false,
  activeAcpMessageId: null,
  activeAcpUserMessageId: null,
};

const KNOWN_PASSIVE_EVENTS = new Set([
  "server.connected",
  "server.heartbeat",
  "sync",
  "models-dev.refreshed",
  "session.created",
  "session.updated",
  "message.part.removed",
  "message.removed",
  "permission.replied",
  "session.diff",
  "session.compacted",
]);

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonRpcId(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export interface OpenCodeModelReference {
  providerId: string;
  modelId: string;
}

export interface OpenCodeProviderRequestExpectation {
  providerId: string;
  modelId: string;
  baselineMessageCount: number;
}

export interface OpenCodeProviderRequestVerification {
  matched: boolean;
  detail: string;
}

export function latestOpenCodeModel(
  history: unknown,
): OpenCodeModelReference | null {
  if (!Array.isArray(history)) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = record(history[index]);
    const info = record(message?.info);
    if (info?.role !== "assistant") continue;
    const providerId = string(info.providerID);
    const modelId = string(info.modelID);
    if (providerId && modelId) return { providerId, modelId };
  }
  return null;
}

export function verifyOpenCodeProviderRequest(
  history: unknown,
  expectation: OpenCodeProviderRequestExpectation,
): OpenCodeProviderRequestVerification {
  if (!Array.isArray(history)) {
    return {
      matched: false,
      detail:
        "OpenCode history was unavailable for Provider request verification",
    };
  }
  const messages = history.slice(Math.max(0, expectation.baselineMessageCount));
  let assistant: JsonObject | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    const info = record(message?.info);
    if (info?.role === "assistant") {
      assistant = info;
      break;
    }
  }
  if (!assistant) {
    return {
      matched: false,
      detail:
        "OpenCode did not record a new assistant response for this request",
    };
  }
  const providerId = string(assistant.providerID);
  const modelId = string(assistant.modelID);
  if (errorMessage(assistant.error)) {
    return {
      matched: false,
      detail: "OpenCode recorded a Provider/model response with a native error",
    };
  }
  const finish = string(assistant.finish);
  if (finish && !["stop", "end_turn"].includes(finish)) {
    return {
      matched: false,
      detail: `OpenCode assistant response ended with non-success finish '${finish}'`,
    };
  }
  if (!finish) {
    return {
      matched: false,
      detail: "OpenCode assistant response has not reached a successful finish",
    };
  }
  if (
    providerId !== expectation.providerId ||
    modelId !== expectation.modelId
  ) {
    return {
      matched: false,
      detail: "OpenCode assistant response used a different Provider or model",
    };
  }
  return {
    matched: true,
    detail: "OpenCode assistant response used the bound provider and model",
  };
}

function displayJson(value: unknown): string {
  const object = record(value);
  if (!object || Object.keys(object).length === 0) return "";
  try {
    return JSON.stringify(object);
  } catch {
    return "";
  }
}

function errorMessage(value: unknown): string {
  const error = record(value);
  if (!error) return string(value);
  const data = record(error.data);
  const action = record(error.action);
  return (
    string(error.message) ||
    string(data?.message) ||
    string(action?.message) ||
    string(error.name) ||
    "OpenCode 请求失败。"
  );
}

function toolFromPart(part: JsonObject): ToolActivity | null {
  if (part.type !== "tool") return null;
  const state = record(part.state);
  const status = string(state?.status);
  const output = string(state?.output);
  const failure = string(state?.error);
  const title = string(state?.title);
  const input = displayJson(state?.input);
  return {
    kind: "tool",
    id: string(part.id) || string(part.callID),
    name: string(part.tool) || "tool",
    summary: failure || output || title || input,
    state:
      status === "completed"
        ? "completed"
        : status === "error"
          ? "failed"
          : "running",
  };
}

function messageFromHistory(value: unknown, index: number): TimelineItem[] {
  const entry = record(value);
  const info = record(entry?.info);
  if (!info) return [];
  const role = info?.role;
  if (role !== "user" && role !== "assistant") return [];
  const parts = Array.isArray(entry?.parts) ? entry.parts : [];
  const text = parts
    .flatMap((value) => {
      const part = record(value);
      return part?.type === "text" && part.ignored !== true
        ? [string(part.text)]
        : [];
    })
    .filter(Boolean)
    .join("\n");
  const thinking = parts
    .flatMap((value) => {
      const part = record(value);
      return part?.type === "reasoning" ? [string(part.text)] : [];
    })
    .filter(Boolean)
    .join("\n");
  const error = role === "assistant" ? errorMessage(info.error) : "";
  const message: TranscriptItem = {
    kind: "message",
    id: string(info.id) || `opencode-history-${index}`,
    role,
    text: text || error,
    ...(thinking ? { thinking } : {}),
    ...(error ? { error: true } : {}),
  };
  const tools = parts.flatMap((value) => {
    const part = record(value);
    const tool = part ? toolFromPart(part) : null;
    return tool ? [tool] : [];
  });
  return role === "user" || text || thinking || error
    ? [message, ...tools]
    : tools;
}

export function hydrateOpenCodeTimeline(history: unknown): TimelineItem[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap(messageFromHistory);
}

function replaceOrAppend(
  timeline: TimelineItem[],
  next: TimelineItem,
): TimelineItem[] {
  const index = timeline.findIndex(
    (item) => item.kind === next.kind && item.id === next.id,
  );
  if (index < 0) return [...timeline, next];
  return timeline.map((item, current) => (current === index ? next : item));
}

function updateMessage(
  timeline: TimelineItem[],
  messageId: string,
  fallbackRole: "user" | "assistant",
  update: (current: TranscriptItem) => TranscriptItem,
  replaceOptimisticText = false,
): TimelineItem[] {
  const existing = timeline.find(
    (item): item is TranscriptItem =>
      item.kind === "message" && item.id === messageId,
  );
  if (!existing && fallbackRole === "user") {
    let localIndex = -1;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (
        item?.kind === "message" &&
        item.role === "user" &&
        item.id.startsWith("local-")
      ) {
        localIndex = index;
        break;
      }
    }
    if (localIndex >= 0) {
      return timeline.map((item, index) =>
        index === localIndex && item.kind === "message"
          ? update({
              ...item,
              id: messageId,
              text: replaceOptimisticText ? "" : item.text,
            })
          : item,
      );
    }
  }
  const current: TranscriptItem = existing ?? {
    kind: "message",
    id: messageId,
    role: fallbackRole,
    text: "",
    pending: true,
  };
  return replaceOrAppend(timeline, update(current));
}

function nextLocalAcpMessageId(timeline: TimelineItem[]): string {
  let highest = 0;
  for (const item of timeline) {
    if (item.kind !== "message") continue;
    const match = /^acp-agent-message-(\d+)$/.exec(item.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `acp-agent-message-${highest + 1}`;
}

function nextLocalAcpUserMessageId(timeline: TimelineItem[]): string {
  let highest = 0;
  for (const item of timeline) {
    if (item.kind !== "message") continue;
    const match = /^acp-user-message-(\d+)$/.exec(item.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `acp-user-message-${highest + 1}`;
}

function pendingMessage(
  timeline: TimelineItem[],
  messageId: string | null,
): TranscriptItem | null {
  if (!messageId) return null;
  return (
    timeline.find(
      (item): item is TranscriptItem =>
        item.kind === "message" &&
        item.id === messageId &&
        item.role === "assistant" &&
        item.pending === true,
    ) ?? null
  );
}

function settlePendingMessages(timeline: TimelineItem[]): TimelineItem[] {
  return timeline.map((item) =>
    item.kind === "message" && item.pending
      ? { ...item, pending: false }
      : item,
  );
}

export interface OpenCodeNativeEvent {
  type: string;
  properties: JsonObject;
  raw: unknown;
}

export function unwrapOpenCodeEvent(
  envelopePayload: unknown,
): OpenCodeNativeEvent | null {
  const outer = record(envelopePayload);
  const event = record(outer?.payload) ?? outer;
  const type = string(event?.type);
  if (!event || !type) return null;
  return {
    type,
    properties: record(event.properties) ?? {},
    raw: envelopePayload,
  };
}

function permissionFromProperties(
  properties: JsonObject,
): OpenCodePermissionRequest | null {
  const id = string(properties.id);
  const sessionId = string(properties.sessionID);
  const permission = string(properties.permission);
  if (!id.startsWith("per_") || !sessionId.startsWith("ses_") || !permission)
    return null;
  return {
    id,
    sessionId,
    permission,
    patterns: strings(properties.patterns),
    always: strings(properties.always),
    metadata: record(properties.metadata) ?? {},
    adapter: "server",
  };
}

function textFromContentBlock(content: unknown): string {
  const block = record(content);
  if (!block) return "";
  if (block.type === "text") return string(block.text);
  if (block.type === "resource") {
    const resource = record(block.resource);
    return string(resource?.text) || string(resource?.uri);
  }
  if (block.type === "resource_link")
    return string(block.title) || string(block.name);
  return "";
}

function acpEnvelope(envelopePayload: unknown): JsonObject | null {
  return record(envelopePayload);
}

function acpTool(update: JsonObject): ToolActivity | null {
  const id = string(update.toolCallId);
  if (!id) return null;
  const status = string(update.status);
  const content = Array.isArray(update.content)
    ? update.content
        .map((item) => textFromContentBlock(record(item)?.content))
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    kind: "tool",
    id,
    name: string(update.title) || string(update.kind) || "ACP tool",
    summary:
      content || displayJson(update.rawInput) || displayJson(update.rawOutput),
    state:
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : "running",
  };
}

function acpPermission(payload: JsonObject): OpenCodePermissionRequest | null {
  const id = jsonRpcId(payload.id);
  const params = record(payload.params);
  const sessionId = string(params?.sessionId);
  const toolCall = record(params?.toolCall);
  const options = Array.isArray(params?.options)
    ? params.options
        .map((item) => {
          const option = record(item);
          return {
            optionId: string(option?.optionId),
            name: string(option?.name),
            kind: string(option?.kind),
          };
        })
        .filter((option) => option.optionId && option.name && option.kind)
    : [];
  if (!id || !sessionId || options.length === 0) return null;
  return {
    id,
    sessionId,
    permission: string(toolCall?.title) || string(toolCall?.kind) || "tool",
    patterns: Array.isArray(record(toolCall?._meta)?.farfoldPermissionPatterns)
      ? (
          record(toolCall?._meta)!.farfoldPermissionPatterns as unknown[]
        ).filter((value): value is string => typeof value === "string")
      : string(record(toolCall?.rawInput)?.command)
        ? [string(record(toolCall?.rawInput)?.command)]
        : [],
    always: [],
    metadata: {
      toolCall,
      options,
    },
    options,
    requestKind: "permission",
    adapter: "acp",
  };
}

function acpQuestion(payload: JsonObject): OpenCodePermissionRequest | null {
  const id = jsonRpcId(payload.id);
  const params = record(payload.params);
  const sessionId = string(params?.sessionId);
  const schema = record(params?.requestedSchema);
  const properties = record(schema?.properties);
  const choice = record(properties?.choice);
  const choices = Array.isArray(choice?.enum)
    ? choice.enum.filter((item): item is string => typeof item === "string")
    : [];
  const options = choices.length
    ? choices.map((value) => ({
        optionId: value,
        name: value,
        kind: "accept",
      }))
    : [
        {
          optionId: "accept",
          name: "确认",
          kind: "accept",
        },
      ];
  if (!id || !sessionId) return null;
  const questionFields = Object.entries(properties ?? {}).flatMap(
    ([key, value]) => {
      const field = record(value);
      const meta = record(field?._meta);
      if (meta?.farfoldCustomFor) return [];
      const items = record(field?.items);
      const labels = field?.type === "array" ? items?.enum : field?.enum;
      if (
        !Array.isArray(labels) ||
        !labels.every((label) => typeof label === "string")
      )
        return [];
      const details = Array.isArray(meta?.farfoldQuestionOptions)
        ? meta.farfoldQuestionOptions
        : [];
      return [
        {
          id: key,
          title: string(field?.title) || string(params?.message),
          multiple: field?.type === "array",
          customField: string(meta?.farfoldCustomField) || null,
          options: labels.map((label) => ({
            label,
            description: string(
              record(details.find((entry) => record(entry)?.label === label))
                ?.description,
            ),
          })),
        },
      ];
    },
  );
  return {
    id,
    sessionId,
    requestKind: "question",
    permission: string(params?.message) || "OpenCode 需要你选择",
    patterns: [],
    always: [],
    metadata: {
      mode: params?.mode,
      requestedSchema: schema,
    },
    options,
    questionFields,
    adapter: "acp",
  };
}

export interface OpenCodeAcpProjectionFeatures {
  questionBridge: boolean;
}

const DEFAULT_ACP_PROJECTION_FEATURES: OpenCodeAcpProjectionFeatures = {
  questionBridge: false,
};

function reduceAcpEvent(
  state: OpenCodeConversationState,
  envelopePayload: unknown,
  nativeSessionId: string,
  features: OpenCodeAcpProjectionFeatures,
): OpenCodeConversationState {
  const payload = acpEnvelope(envelopePayload);
  const method = string(payload?.method);
  if (!payload || !method) {
    return {
      ...state,
      unknownEventCount: state.unknownEventCount + 1,
      notice: "OpenCode ACP 发出了无法识别的原生事件；Farfold 已保留它。",
    };
  }
  if (method === "_farfold/session_recovery" && features.questionBridge) {
    const params = record(payload.params);
    if (
      params?.sessionId !== nativeSessionId ||
      params.reason !== "native_question_no_longer_pending"
    )
      return state;
    const questions = Array.isArray(params.unavailableQuestions)
      ? params.unavailableQuestions
      : [];
    if (!questions.length) return state;
    const recoveryNotice =
      "此前的提问已不在 OpenCode 待答列表中，旧选项无法继续提交。历史已保留；请检查未完成的工作，再发送新的指令。";
    const unavailableIds = new Set(
      questions.map((item) => string(record(item)?.nativePartId)),
    );
    return {
      ...state,
      timeline: state.timeline.map((item) =>
        item.kind === "tool" && unavailableIds.has(item.id)
          ? {
              ...item,
              state: "interrupted",
              summary: `${item.summary}\n${recoveryNotice}`,
            }
          : item,
      ),
      permissions: state.permissions.filter(
        (item) => item.requestKind !== "question",
      ),
      recoveryNotice,
      notice: recoveryNotice,
    };
  }
  if (method === "session/request_permission") {
    const permission = acpPermission(payload);
    if (!permission || permission.sessionId !== nativeSessionId) return state;
    return {
      ...state,
      permissions: [
        ...state.permissions.filter((item) => item.id !== permission.id),
        permission,
      ],
      runtimeObserved: true,
      isWorking: true,
      notice: null,
    };
  }
  if (method === "elicitation/create") {
    if (!features.questionBridge) {
      return {
        ...state,
        unknownEventCount: state.unknownEventCount + 1,
        notice:
          "OpenCode ACP 发出了 form elicitation，但当前 adapter 未声明原生提问桥接；已保留原始事件。",
      };
    }
    const question = acpQuestion(payload);
    if (!question || question.sessionId !== nativeSessionId) return state;
    return {
      ...state,
      permissions: [
        ...state.permissions.filter((item) => item.id !== question.id),
        question,
      ],
      runtimeObserved: true,
      isWorking: true,
      notice: null,
    };
  }
  if (method !== "session/update") {
    return {
      ...state,
      unknownEventCount: state.unknownEventCount + 1,
      notice: `OpenCode ACP 发出了 Farfold 尚未适配的事件（${method}）；已保留原始事件。`,
    };
  }
  const params = record(payload.params);
  const sessionId = string(params?.sessionId);
  if (!sessionId) {
    return {
      ...state,
      unknownEventCount: state.unknownEventCount + 1,
      notice: "OpenCode ACP session/update 缺少 Session；已保留原始事件。",
    };
  }
  if (sessionId !== nativeSessionId) return state;
  const update = record(params?.update);
  if (!update) {
    return {
      ...state,
      unknownEventCount: state.unknownEventCount + 1,
      notice: "OpenCode ACP session/update 缺少 update；已保留原始事件。",
    };
  }
  const sessionUpdate = string(update?.sessionUpdate);
  if (sessionUpdate === "user_message_chunk") {
    const nativeMessageId = string(update?.messageId);
    const messageId =
      nativeMessageId ||
      state.activeAcpUserMessageId ||
      nextLocalAcpUserMessageId(state.timeline);
    const text = textFromContentBlock(update?.content);
    const timeline = state.activeAcpMessageId
      ? settlePendingMessages(state.timeline)
      : state.timeline;
    return {
      ...state,
      runtimeObserved: true,
      outcomeUnknown: false,
      activeAcpMessageId: null,
      activeAcpUserMessageId: nativeMessageId ? null : messageId,
      notice: null,
      timeline: updateMessage(
        timeline,
        messageId,
        "user",
        (current) => ({
          ...current,
          text: `${current.text}${text}`,
          pending: false,
        }),
        true,
      ),
    };
  }
  if (sessionUpdate === "available_commands_update") {
    return {
      ...state,
      runtimeObserved: true,
      notice: null,
    };
  }
  if (sessionUpdate === "agent_message_chunk") {
    const nativeMessageId = string(update?.messageId);
    const messageId =
      nativeMessageId ||
      pendingMessage(state.timeline, state.activeAcpMessageId)?.id ||
      nextLocalAcpMessageId(state.timeline);
    const text = textFromContentBlock(update?.content);
    return {
      ...state,
      isWorking: true,
      runtimeObserved: true,
      outcomeUnknown: false,
      activeAcpUserMessageId: null,
      activeAcpMessageId: nativeMessageId ? null : messageId,
      notice: null,
      timeline: updateMessage(
        state.timeline,
        messageId,
        "assistant",
        (current) => ({
          ...current,
          text: `${current.text}${text}`,
          pending: true,
        }),
      ),
    };
  }
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    const tool = acpTool(update);
    if (!tool) return state;
    return {
      ...state,
      isWorking: true,
      runtimeObserved: true,
      outcomeUnknown: false,
      notice: null,
      timeline: replaceOrAppend(state.timeline, tool),
    };
  }
  if (sessionUpdate === "plan") {
    const entries = Array.isArray(update?.entries) ? update.entries : [];
    const summary = entries
      .map((entry) => {
        const item = record(entry);
        const status = string(item?.status);
        const content = string(item?.content);
        return content ? `${status ? `${status}: ` : ""}${content}` : "";
      })
      .filter(Boolean)
      .join("\n");
    return {
      ...state,
      isWorking: true,
      runtimeObserved: true,
      timeline: replaceOrAppend(state.timeline, {
        kind: "tool",
        id: "acp-plan",
        name: "Plan",
        summary,
        state: entries.some((entry) => record(entry)?.status === "in_progress")
          ? "running"
          : "completed",
      }),
    };
  }
  if (
    sessionUpdate === "usage_update" ||
    sessionUpdate === "config_option_update"
  )
    return state;
  return {
    ...state,
    unknownEventCount: state.unknownEventCount + 1,
    notice: `OpenCode ACP 发出了 Farfold 尚未适配的 session/update（${sessionUpdate || "unknown"}）；已保留原始事件。`,
  };
}

function belongsToSession(
  properties: JsonObject,
  nativeSessionId: string,
): boolean {
  const eventSessionId = string(properties.sessionID);
  return !eventSessionId || eventSessionId === nativeSessionId;
}

export function isOpenCodeIdleEvent(
  payload: unknown,
  nativeSessionId: string,
): boolean {
  const event = unwrapOpenCodeEvent(payload);
  return (
    event?.properties.sessionID === nativeSessionId &&
    (event.type === "session.idle" ||
      (event.type === "session.status" &&
        record(event.properties.status)?.type === "idle"))
  );
}

const UNOBSERVED_IDLE_NOTICE =
  "OpenCode 当前空闲，但提交是否执行仍未确认；草稿和任务占用已保留。";

export function openCodeIdleNotice(
  state: OpenCodeConversationState,
): string | null {
  if (state.retryDetail !== null)
    return `OpenCode Provider 重试已结束${state.retryDetail}`;
  return state.notice === UNOBSERVED_IDLE_NOTICE ? null : state.notice;
}

export function settleOpenCodeConversation(
  state: OpenCodeConversationState,
): OpenCodeConversationState {
  return {
    ...state,
    isWorking: false,
    outcomeUnknown: false,
    runtimeObserved: false,
    activeAcpMessageId: null,
    activeAcpUserMessageId: null,
    permissions: [],
    notice: state.recoveryNotice ?? openCodeIdleNotice(state),
    retryDetail: null,
    timeline: settlePendingMessages(state.timeline),
  };
}

function nativeIdle(
  state: OpenCodeConversationState,
): OpenCodeConversationState {
  if (state.isWorking && !state.runtimeObserved) {
    return {
      ...state,
      outcomeUnknown: true,
      notice: UNOBSERVED_IDLE_NOTICE,
    };
  }
  return settleOpenCodeConversation(state);
}

export function reduceOpenCodeEvent(
  state: OpenCodeConversationState,
  envelope: OpenCodeEnvelope,
  nativeSessionId: string,
  acpFeatures: OpenCodeAcpProjectionFeatures = DEFAULT_ACP_PROJECTION_FEATURES,
): OpenCodeConversationState {
  if (envelope.kind === "acp") {
    return reduceAcpEvent(
      state,
      envelope.payload,
      nativeSessionId,
      acpFeatures,
    );
  }
  if (envelope.kind !== "sse") {
    const failure = errorMessage(envelope.payload);
    const recoveryNotice = state.permissions.length
      ? "连接已中断，旧提问和权限请求已失效。恢复会话后请核对历史；输入不会自动重发。"
      : state.recoveryNotice;
    return {
      ...state,
      permissions: [],
      recoveryNotice,
      outcomeUnknown: state.isWorking || state.outcomeUnknown,
      notice: `OpenCode 事件连接中断，任务结果尚未确认：${failure}`,
      retryDetail: null,
    };
  }
  const event = unwrapOpenCodeEvent(envelope.payload);
  if (!event) {
    return {
      ...state,
      unknownEventCount: state.unknownEventCount + 1,
      notice:
        "OpenCode 发出了无法识别的原始事件；Farfold 已保留它，未推断其含义。",
    };
  }
  if (!belongsToSession(event.properties, nativeSessionId)) return state;

  if (event.type === "session.status") {
    const status = record(event.properties.status);
    const type = string(status?.type);
    if (type === "busy")
      return {
        ...state,
        isWorking: true,
        runtimeObserved: true,
        outcomeUnknown: false,
        notice: null,
        retryDetail: null,
      };
    if (type === "idle") return nativeIdle(state);
    if (type === "retry") {
      const message = string(status?.message);
      const action = record(status?.action);
      const reason = string(action?.reason);
      const detail = `${reason ? `（${reason}）` : ""}${message ? `：${message}` : "。"}`;
      return {
        ...state,
        isWorking: true,
        runtimeObserved: true,
        outcomeUnknown: false,
        retryDetail: detail,
        notice: `OpenCode Provider 正在重试${detail}`,
      };
    }
  }
  if (event.type === "session.idle") {
    return nativeIdle(state);
  }
  if (event.type === "session.error") {
    // Native input-read failures can emit this while processing continues.
    // Keep activity and uncertainty until an actual native status resolves them.
    return {
      ...state,
      notice: `OpenCode：${errorMessage(event.properties.error)}`,
      retryDetail: null,
    };
  }
  if (event.type === "message.updated") {
    const info = record(event.properties.info);
    if (!info) return state;
    const messageId = string(info?.id);
    const role = info?.role;
    if (!messageId || (role !== "user" && role !== "assistant")) return state;
    const error = role === "assistant" ? errorMessage(info.error) : "";
    return {
      ...state,
      timeline: updateMessage(state.timeline, messageId, role, (current) => ({
        ...current,
        role,
        pending: role === "assistant" ? !string(info.finish) : false,
        ...(error ? { text: current.text || error, error: true } : {}),
      })),
    };
  }
  if (event.type === "message.part.delta") {
    const messageId = string(event.properties.messageID);
    const delta = string(event.properties.delta);
    const field = string(event.properties.field);
    if (!messageId || !delta) return state;
    return {
      ...state,
      timeline: updateMessage(
        state.timeline,
        messageId,
        "assistant",
        (current) =>
          field === "reasoning"
            ? {
                ...current,
                thinking: `${current.thinking ?? ""}${delta}`,
                pending: true,
              }
            : { ...current, text: `${current.text}${delta}`, pending: true },
      ),
    };
  }
  if (event.type === "message.part.updated") {
    const part = record(event.properties.part);
    if (!part) return state;
    const tool = toolFromPart(part);
    if (tool) {
      return {
        ...state,
        timeline: replaceOrAppend(state.timeline, tool),
      };
    }
    const messageId = string(part.messageID);
    if (!messageId) return state;
    if (part.type === "text") {
      return {
        ...state,
        timeline: updateMessage(
          state.timeline,
          messageId,
          "assistant",
          (current) => ({
            ...current,
            text: string(part.text),
            pending: true,
          }),
        ),
      };
    }
    if (part.type === "reasoning") {
      return {
        ...state,
        timeline: updateMessage(
          state.timeline,
          messageId,
          "assistant",
          (current) => ({
            ...current,
            thinking: string(part.text),
            pending: true,
          }),
        ),
      };
    }
    return state;
  }
  if (event.type === "permission.asked") {
    const permission = permissionFromProperties(event.properties);
    if (!permission) return state;
    return {
      ...state,
      permissions: [
        ...state.permissions.filter((item) => item.id !== permission.id),
        permission,
      ],
    };
  }
  if (event.type === "permission.replied") {
    const requestId = string(event.properties.requestID);
    return {
      ...state,
      permissions: state.permissions.filter((item) => item.id !== requestId),
    };
  }
  if (KNOWN_PASSIVE_EVENTS.has(event.type)) return state;

  return {
    ...state,
    unknownEventCount: state.unknownEventCount + 1,
    notice: `OpenCode 发出了 Farfold 尚未适配的事件（${event.type}）；已保留原始事件，未推断其含义。`,
  };
}
