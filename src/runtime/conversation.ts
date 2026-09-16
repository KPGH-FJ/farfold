export interface TranscriptItem {
  kind: "message";
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  pending?: boolean;
  error?: boolean;
}

export interface ToolActivity {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  state: "running" | "completed" | "failed" | "interrupted";
}

export type TimelineItem = TranscriptItem | ToolActivity;

export interface ConversationState {
  timeline: TimelineItem[];
  isWorking: boolean;
  steering: string[];
  followUp: string[];
  notice: string | null;
  manualCompaction?: boolean;
}

export const initialConversation: ConversationState = {
  timeline: [],
  isWorking: false,
  steering: [],
  followUp: [],
  notice: null,
};

type JsonObject = Record<string, unknown>;

const DOCUMENTED_PI_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "bash_execution_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "extension_error",
  "extension_ui_request",
]);

export interface UnknownPiEventProjection {
  type: string;
  notice: string;
  raw: unknown;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function projectUnknownPiEvent(
  payload: unknown,
): UnknownPiEventProjection | null {
  const event = asObject(payload);
  const type = stringValue(event?.type);
  if (type && DOCUMENTED_PI_EVENT_TYPES.has(type)) return null;
  const label = type || "缺少 type";
  return {
    type: label,
    notice: `Pi 发出了 Farfold 尚未适配的事件（${label}）；已保留原始事件，未推断其含义。`,
    raw: payload,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asObject(part);
      return block?.type === "text" ? stringValue(block.text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asObject(part);
      return block?.type === "thinking" ? stringValue(block.thinking) : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function formatProviderError(value: string): string {
  if (/^402:.*Insufficient Balance/i.test(value)) {
    return "Provider 余额不足（402 Insufficient Balance）。请充值或切换到可用 Provider 后重试。";
  }
  const match = value.match(/^(\d{3}):\s*(\{.*\})$/s);
  if (!match) return `请求失败：${value}`;
  try {
    const message = stringValue(
      asObject(JSON.parse(match[2]) as unknown)?.message,
    );
    return message
      ? `请求失败（${match[1]}）：${message}`
      : `请求失败（${match[1]}）。`;
  } catch {
    return `请求失败（${match[1]}）。`;
  }
}

export function piInterruptionMessage(
  message: Record<string, unknown>,
): string | null {
  if (message.stopReason === "aborted") return "已停止。";
  // The pinned Pi runtime can record a cancelled request as a transport error.
  // This proves interruption, but does not by itself prove who requested it.
  if (
    message.stopReason === "error" &&
    message.errorMessage === "The operation was aborted."
  ) {
    return "请求已中断，可继续对话。";
  }
  return null;
}

function transcriptFromMessage(
  message: unknown,
  fallbackId: string,
): TranscriptItem | null {
  const record = asObject(message);
  if (!record) return null;
  const role = record.role;
  if (role !== "user" && role !== "assistant") return null;
  const interruption =
    role === "assistant" ? piInterruptionMessage(record) : null;
  const errorMessage = stringValue(record.errorMessage);
  const text = textFromContent(record.content);
  const thinking = thinkingFromContent(record.content);
  return {
    kind: "message",
    id: stringValue(record.id) || fallbackId,
    role,
    text: interruption
      ? [text, interruption].filter(Boolean).join("\n\n")
      : text ||
        (role === "assistant" && errorMessage
          ? formatProviderError(errorMessage)
          : ""),
    ...(errorMessage && !interruption ? { error: true } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function isVisibleTranscript(item: TranscriptItem): boolean {
  return (
    item.role === "user" || Boolean(item.text || item.thinking || item.error)
  );
}

function toolFromMessage(
  message: unknown,
  fallbackId: string,
): ToolActivity | null {
  const record = asObject(message);
  if (!record) return null;
  if (record.role === "toolResult") {
    return {
      kind: "tool",
      id: stringValue(record.toolCallId) || fallbackId,
      name: stringValue(record.toolName) || "tool",
      summary: textFromContent(record.content),
      state: record.isError === true ? "failed" : "completed",
    };
  }
  if (record.role === "bashExecution") {
    return {
      kind: "tool",
      id: fallbackId,
      name: "bash",
      summary: stringValue(record.output) || stringValue(record.command),
      state:
        record.cancelled === true ||
        (typeof record.exitCode === "number" && record.exitCode !== 0)
          ? "failed"
          : "completed",
    };
  }
  return null;
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

function displayToolSummary(value: unknown): string {
  const args = asObject(value);
  if (!args) return "";
  if (typeof args.command === "string") return args.command;
  const compact = JSON.stringify(args);
  return compact === "{}" ? "" : compact;
}

function textFromToolResult(value: unknown): string {
  return textFromContent(asObject(value)?.content);
}

export function hydrateTimeline(messages: unknown): TimelineItem[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message, index) => {
    const fallbackId = `history-${index}`;
    const transcript = transcriptFromMessage(message, fallbackId);
    const item =
      transcript && isVisibleTranscript(transcript)
        ? transcript
        : toolFromMessage(message, fallbackId);
    return item ? [item] : [];
  });
}

export function reducePiEvent(
  state: ConversationState,
  payload: unknown,
): ConversationState {
  const event = asObject(payload);
  if (!event) return state;
  const type = stringValue(event.type);

  if (type === "agent_start")
    return { ...state, isWorking: true, notice: null };
  if (type === "agent_settled") return { ...state, isWorking: false };
  if (type === "queue_update") {
    return {
      ...state,
      steering: Array.isArray(event.steering)
        ? event.steering.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
      followUp: Array.isArray(event.followUp)
        ? event.followUp.filter(
            (item): item is string => typeof item === "string",
          )
        : [],
    };
  }
  if (type === "message_start") {
    const item = transcriptFromMessage(
      event.message,
      `stream-${state.timeline.length}`,
    );
    if (!item || item.role !== "assistant") return state;
    return {
      ...state,
      timeline: replaceOrAppend(state.timeline, { ...item, pending: true }),
    };
  }
  if (type === "message_update") {
    const delta = asObject(event.assistantMessageEvent);
    if (delta?.type !== "text_delta" && delta?.type !== "thinking_delta")
      return state;
    const pendingIndex = state.timeline.reduce(
      (latest, item, index) =>
        item.kind === "message" && item.role === "assistant" && item.pending
          ? index
          : latest,
      -1,
    );
    if (pendingIndex < 0) return state;
    return {
      ...state,
      timeline: state.timeline.map((item, index) =>
        index === pendingIndex && item.kind === "message"
          ? delta.type === "thinking_delta"
            ? {
                ...item,
                thinking: (item.thinking ?? "") + stringValue(delta.delta),
              }
            : { ...item, text: item.text + stringValue(delta.delta) }
          : item,
      ),
    };
  }
  if (type === "message_end") {
    const item = transcriptFromMessage(
      event.message,
      `stream-${state.timeline.length}`,
    );
    if (!item || item.role !== "assistant") return state;
    const pendingIndex = state.timeline.reduce(
      (latest, current, index) =>
        current.kind === "message" &&
        current.role === "assistant" &&
        current.pending
          ? index
          : latest,
      -1,
    );
    if (!isVisibleTranscript(item)) {
      return pendingIndex < 0
        ? state
        : {
            ...state,
            timeline: state.timeline.filter(
              (_current, index) => index !== pendingIndex,
            ),
          };
    }
    if (pendingIndex < 0) {
      return { ...state, timeline: replaceOrAppend(state.timeline, item) };
    }
    const pending = state.timeline[pendingIndex];
    const id =
      item.id.startsWith("stream-") && pending.kind === "message"
        ? pending.id
        : item.id;
    return {
      ...state,
      timeline: state.timeline.map((current, index) =>
        index === pendingIndex ? { ...item, id, pending: false } : current,
      ),
    };
  }
  if (type === "tool_execution_start") {
    const id = stringValue(event.toolCallId);
    if (!id) return state;
    const tool: ToolActivity = {
      kind: "tool",
      id,
      name: stringValue(event.toolName) || "tool",
      summary: displayToolSummary(event.args),
      state: "running",
    };
    return { ...state, timeline: replaceOrAppend(state.timeline, tool) };
  }
  if (type === "tool_execution_update" || type === "tool_execution_end") {
    const id = stringValue(event.toolCallId);
    if (!id) return state;
    return {
      ...state,
      timeline: state.timeline.map((item) => {
        if (item.kind !== "tool" || item.id !== id) return item;
        return {
          ...item,
          summary:
            textFromToolResult(
              type === "tool_execution_end"
                ? event.result
                : event.partialResult,
            ) || item.summary,
          state:
            type === "tool_execution_end"
              ? event.isError === true
                ? "failed"
                : "completed"
              : item.state,
        };
      }),
    };
  }
  if (type === "compaction_start") {
    return {
      ...state,
      manualCompaction: event.reason === "manual",
      notice:
        event.reason === "manual"
          ? "Pi 正在手动压缩上下文；固定版本不支持停止此操作。"
          : "Pi 正在压缩上下文。",
    };
  }
  if (type === "compaction_end") {
    return {
      ...state,
      manualCompaction: false,
      notice:
        event.aborted === true
          ? "上下文压缩已取消。"
          : typeof event.errorMessage === "string"
            ? `上下文压缩失败：${event.errorMessage}`
            : "上下文压缩已完成。",
    };
  }
  if (type === "auto_retry_start") {
    const attempt =
      typeof event.attempt === "number" ? `（第 ${event.attempt} 次）` : "";
    return { ...state, notice: `Pi 正在按自身策略重试请求${attempt}。` };
  }
  if (type === "auto_retry_end") {
    return {
      ...state,
      notice:
        event.success === true
          ? "Pi 重试成功。"
          : `Pi 重试失败：${stringValue(event.finalError) || "已达到重试上限"}`,
    };
  }
  if (type === "summarization_retry_scheduled") {
    return { ...state, notice: "Pi 将重试上下文摘要。" };
  }
  if (type === "summarization_retry_attempt_start") {
    return { ...state, notice: "Pi 正在重试上下文摘要。" };
  }
  if (type === "summarization_retry_finished") {
    return { ...state, notice: "上下文摘要重试已结束。" };
  }
  if (type === "extension_error") {
    return {
      ...state,
      notice: `Pi extension error: ${stringValue(event.error)}`,
    };
  }
  return state;
}
