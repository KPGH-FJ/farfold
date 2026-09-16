import type { CodexNativeTurn } from "./codex-session";
import {
  runtimeEnvelopeFromHostEvent,
  type HostRoutedEvent,
} from "./host-shadow";

export type CodexPhase =
  | "idle"
  | "submitting"
  | "executing"
  | "stopping"
  | "completed"
  | "interrupted"
  | "failed"
  | "rejected"
  | "unknown";
export interface CodexConversation {
  turns: CodexNativeTurn[];
  phase: CodexPhase;
  nativeTurnId: string | null;
  hostTurnId: string | null;
  latestSequence: number;
  diagnostics: string[];
  truncated: boolean;
}
export interface CodexEventScope {
  installationId: string;
  runtimeBuildId: string;
  connectionId: string;
  generation: number;
  nativeSessionId: string;
}
const phases: CodexPhase[] = [
  "idle",
  "submitting",
  "executing",
  "stopping",
  "completed",
  "interrupted",
  "failed",
  "rejected",
  "unknown",
];
export const codexBusy = (phase: CodexPhase) =>
  ["submitting", "executing", "stopping", "unknown"].includes(phase);
export function codexConversation(
  turns: CodexNativeTurn[] = [],
): CodexConversation {
  return {
    turns,
    phase: "idle",
    nativeTurnId: null,
    hostTurnId: null,
    latestSequence: 0,
    diagnostics: [],
    truncated: false,
  };
}
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function diagnostic(
  state: CodexConversation,
  message: string,
): CodexConversation {
  return { ...state, diagnostics: [...state.diagnostics.slice(-15), message] };
}
function bounded(state: CodexConversation): CodexConversation {
  if (
    state.turns.reduce((sum, t) => sum + t.items.length, 0) > 500 ||
    JSON.stringify(state.turns).length > 2 * 1024 * 1024
  ) {
    return {
      ...state,
      turns: state.turns.slice(-1).map((t) => ({ ...t, items: [] })),
      truncated: true,
      phase: "unknown",
      diagnostics: ["显示缓冲已达上限，需从原生历史重新核对；此视图不完整。"],
    };
  }
  return state;
}
export function codexEventMatchesScope(
  event: HostRoutedEvent,
  scope: CodexEventScope,
): boolean {
  return (
    event.runtime.productId === "codex" &&
    event.runtime.adapterId === "codex-app-server" &&
    event.runtime.installationId === scope.installationId &&
    event.runtimeBuildId === scope.runtimeBuildId &&
    event.connectionId === scope.connectionId &&
    event.runtimeGeneration === scope.generation
  );
}

export function applyCodexEvent(
  previous: CodexConversation,
  event: HostRoutedEvent,
  scope: CodexEventScope,
): CodexConversation {
  if (
    !codexEventMatchesScope(event, scope) ||
    event.sequence <= previous.latestSequence
  )
    return previous;
  const envelope = runtimeEnvelopeFromHostEvent(event);
  let state = { ...previous, latestSequence: event.sequence };
  if (!envelope || ["transport_gap", "transport_error"].includes(event.kind)) {
    return diagnostic(
      {
        ...state,
        phase: codexBusy(state.phase) ? "unknown" : state.phase,
        truncated: true,
      },
      "Codex 事件连接中断或不完整；请核对原生历史，输入不会自动重发。",
    );
  }
  const payload = object(envelope.payload);
  if (!payload) return diagnostic(state, "Codex 事件结构无法识别");
  // Pending operations come from the shared Host interaction snapshot.
  if (
    [
      "codex_interaction",
      "codex_interaction_reply_sent",
      "codex_interactions_invalidated",
    ].includes(event.kind)
  )
    return state;
  if (event.kind === "codex_turn_state") {
    if (
      payload.nativeSessionId !== scope.nativeSessionId ||
      typeof payload.hostTurnId !== "string" ||
      typeof payload.phase !== "string" ||
      !phases.includes(payload.phase as CodexPhase)
    )
      return state;
    if (
      payload.phase !== "submitting" &&
      state.hostTurnId !== payload.hostTurnId
    )
      return state;
    return {
      ...state,
      hostTurnId: payload.hostTurnId,
      nativeTurnId:
        typeof payload.nativeTurnId === "string"
          ? payload.nativeTurnId
          : state.nativeTurnId,
      phase: payload.phase as CodexPhase,
    };
  }
  if (event.kind !== "codex_rpc") return state;
  const params = object(payload.params);
  if (!params || params.threadId !== scope.nativeSessionId) return state;
  const method = payload.method;
  if (
    [
      "serverRequest/resolved",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
    ].includes(String(method))
  )
    return state;
  const nativeTurn = object(params.turn);
  const turnId =
    typeof params.turnId === "string"
      ? params.turnId
      : typeof nativeTurn?.id === "string"
        ? nativeTurn.id
        : null;
  if (method === "turn/started" || method === "turn/completed") {
    if (!nativeTurn || !turnId || typeof nativeTurn.status !== "string")
      return diagnostic(state, "Codex 原生轮次事件不完整");
    const existing = state.turns.find((t) => t.id === turnId);
    const items =
      Array.isArray(nativeTurn.items) && nativeTurn.items.length
        ? nativeTurn.items.filter(
            (i): i is Record<string, unknown> => object(i) !== null,
          )
        : (existing?.items ?? []);
    const next: CodexNativeTurn = {
      ...existing,
      ...nativeTurn,
      id: turnId,
      status: nativeTurn.status,
      items,
    };
    state = {
      ...state,
      turns: existing
        ? state.turns.map((t) => (t.id === turnId ? next : t))
        : [...state.turns, next],
    };
    // Native end is rendered, but only the Host's scoped state releases working.
    return bounded(state);
  }
  if (method === "item/started" || method === "item/completed") {
    const item = object(params.item);
    if (!turnId || !item || typeof item.id !== "string")
      return diagnostic(state, "Codex 原生条目身份缺失");
    const turn = state.turns.find((t) => t.id === turnId);
    if (!turn)
      return diagnostic(
        { ...state, truncated: true },
        "Codex 条目先于可识别轮次到达，需要历史核对",
      );
    const found = turn.items.some((i) => i.id === item.id);
    const next = {
      ...turn,
      items: found
        ? turn.items.map((i) => (i.id === item.id ? item : i))
        : [...turn.items, item],
    };
    return bounded({
      ...state,
      turns: state.turns.map((t) => (t.id === turnId ? next : t)),
    });
  }
  if (
    method === "item/agentMessage/delta" ||
    method === "item/commandExecution/outputDelta"
  ) {
    const field =
      method === "item/agentMessage/delta" ? "text" : "aggregatedOutput";
    if (
      !turnId ||
      typeof params.itemId !== "string" ||
      typeof params.delta !== "string"
    )
      return diagnostic(state, "Codex 增量身份或文本缺失");
    const turn = state.turns.find((t) => t.id === turnId);
    const item = turn?.items.find((i) => i.id === params.itemId);
    if (!item)
      return diagnostic(
        { ...state, truncated: true },
        "Codex 增量缺少对应条目，需要历史核对",
      );
    const text = typeof item[field] === "string" ? item[field] : "";
    return bounded({
      ...state,
      turns: state.turns.map((t) =>
        t.id === turnId
          ? {
              ...t,
              items: t.items.map((i) =>
                i.id === params.itemId
                  ? { ...i, [field]: text + params.delta }
                  : i,
              ),
            }
          : t,
      ),
    });
  }
  if (
    typeof method === "string" &&
    (method.endsWith("requestApproval") ||
      method === "item/tool/requestUserInput")
  )
    return diagnostic(state, `不支持的原生交互：${method}；未自动批准。`);
  if (method === "error")
    return diagnostic(
      state,
      typeof object(params.error)?.message === "string"
        ? String(object(params.error)?.message)
        : "Codex 返回任务错误，详情需核对原生历史",
    );
  if (typeof method === "string")
    state = diagnostic(state, `原生事件：${method}`);
  return state;
}
