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
  permission: string;
  patterns: string[];
  always: string[];
  metadata: JsonObject;
}

export interface OpenCodeConversationState extends ConversationState {
  permissions: OpenCodePermissionRequest[];
  unknownEventCount: number;
}

export const initialOpenCodeConversation: OpenCodeConversationState = {
  timeline: [],
  isWorking: false,
  steering: [],
  followUp: [],
  notice: null,
  permissions: [],
  unknownEventCount: 0,
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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export interface OpenCodeModelReference {
  providerId: string;
  modelId: string;
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
          ? update({ ...item, id: messageId })
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
  };
}

function belongsToSession(
  properties: JsonObject,
  nativeSessionId: string,
): boolean {
  const eventSessionId = string(properties.sessionID);
  return !eventSessionId || eventSessionId === nativeSessionId;
}

export function reduceOpenCodeEvent(
  state: OpenCodeConversationState,
  envelope: OpenCodeEnvelope,
  nativeSessionId: string,
): OpenCodeConversationState {
  if (envelope.kind !== "sse") {
    const failure = errorMessage(envelope.payload);
    return {
      ...state,
      isWorking: false,
      notice: `OpenCode 传输错误：${failure}`,
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
    if (type === "busy") return { ...state, isWorking: true, notice: null };
    if (type === "idle") return { ...state, isWorking: false };
    if (type === "retry") {
      const message = string(status?.message);
      const action = record(status?.action);
      const reason = string(action?.reason);
      return {
        ...state,
        isWorking: true,
        notice: `OpenCode Provider 正在重试${reason ? `（${reason}）` : ""}${message ? `：${message}` : "。"}`,
      };
    }
  }
  if (event.type === "session.idle") {
    return { ...state, isWorking: false };
  }
  if (event.type === "session.error") {
    return {
      ...state,
      isWorking: false,
      notice: `OpenCode：${errorMessage(event.properties.error)}`,
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
