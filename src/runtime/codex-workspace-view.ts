import { codexWorkspaceRoute } from "./codex-workspace-route";
import {
  codexAcpWorkspaceLabel,
  codexAcpSnapshotMatches,
  sameCodexAcpScope,
  type CodexAcpWorkspaceSnapshot,
} from "./codex-acp-workspace";
import type { CodexAcpScope } from "./codex-acp-contract";
import type { CodexInteraction, CodexTurnTarget } from "./codex-interaction";
import { object } from "./codex-acp-content";
import {
  runtimeEnvelopeFromHostEvent,
  type HostPendingInteraction,
  type HostSessionBinding,
  type HostRoutedEvent,
} from "./host-shadow";
import type { AcpTranscript } from "./codex-acp-transcript";

export type CodexAcpContext = NonNullable<
  CodexAcpWorkspaceSnapshot["activeTurn"]
>["context"];
export interface CodexAcpInteraction {
  scope: CodexAcpScope;
  context: CodexAcpContext;
  nativeTurnId: string;
  nativeMode: string;
  request: CodexInteraction;
  fileChanges:
    | {
        path: string;
        kind: { type: string; move_path?: string | null };
        diff: string;
      }[]
    | null;
}
export interface CodexInteractionView {
  key: string;
  pending: HostPendingInteraction;
  request: CodexInteraction;
  target: CodexTurnTarget;
  fileChanges?: CodexAcpInteraction["fileChanges"];
  unavailableReason?: string;
}
/** Closed ACP views retain reply identity, never raw command/path/diff payloads. */
function closedCodexAcpRequest(request: CodexInteraction): CodexInteraction {
  return {
    ...request,
    nativeRequest: {
      id: request.nativeRequest.id,
      method: request.method,
      params: {
        threadId: request.threadId,
        turnId: request.turnId,
        itemId: request.itemId,
      },
    },
  };
}
export function sameCodexAcpContext(
  a: CodexAcpContext,
  b: CodexAcpContext,
): boolean {
  return (
    a.farfoldSessionId === b.farfoldSessionId &&
    a.hostTurnId === b.hostTurnId &&
    a.workingCopyId === b.workingCopyId &&
    a.thread.nativeThreadId === b.thread.nativeThreadId &&
    a.thread.nativeSessionId === b.thread.nativeSessionId &&
    a.thread.cwd === b.thread.cwd &&
    a.thread.modelProvider === b.thread.modelProvider
  );
}
export interface CodexObservedEvent {
  sequence: number;
  hostTurnId: string;
  nativeTurnId: string;
  kind:
    | "started"
    | "terminal"
    | "item_started"
    | "item_completed"
    | "delta"
    | "interaction_open"
    | "interaction_end";
}
/** Validate scope first, then retain only a bounded, non-content read-only summary. */
export function codexAcpObservedEvent(
  event: HostRoutedEvent,
  snapshot: CodexAcpWorkspaceSnapshot,
): CodexObservedEvent | null {
  const scope = snapshot.scope;
  const active = snapshot.activeTurn;
  if (
    !scope ||
    !active ||
    snapshot.connectionState !== "connected" ||
    event.kind !== "acp" ||
    event.runtime.productId !== scope.runtimeProductId ||
    event.runtime.adapterId !== scope.adapterId ||
    event.runtime.installationId !== scope.installationId ||
    event.runtimeBuildId !== scope.runtimeBuildId ||
    event.connectionId !== scope.connectionId ||
    event.runtimeGeneration !== scope.generation
  )
    return null;
  const payload = object(runtimeEnvelopeFromHostEvent(event)?.payload);
  const params = object(payload?.params);
  if (payload?.method !== "_codex/turn/event" || !params) return null;
  const s = object(params.scope);
  const turn = object(params.turn);
  const context = object(turn?.context);
  const thread = object(context?.thread);
  if (
    !s ||
    !sameCodexAcpScope(s as unknown as CodexAcpScope, scope) ||
    !turn ||
    !context ||
    !thread ||
    !sameCodexAcpContext(
      context as unknown as CodexAcpContext,
      active.context,
    ) ||
    turn.nativeTurnId !== active.nativeTurnId ||
    typeof turn.kind !== "string" ||
    ![
      "started",
      "terminal",
      "item_started",
      "item_completed",
      "delta",
      "interaction_open",
      "interaction_end",
    ].includes(turn.kind)
  )
    return null;
  return {
    sequence: event.sequence,
    hostTurnId: active.context.hostTurnId,
    nativeTurnId: turn.nativeTurnId as string,
    kind: turn.kind as CodexObservedEvent["kind"],
  };
}

function acpInteractions(
  pending: HostPendingInteraction[],
  s: CodexAcpWorkspaceSnapshot,
): CodexInteractionView[] {
  if (
    !s.scope ||
    !s.target ||
    !s.activeTurn ||
    s.connectionState !== "connected"
  )
    return [];
  const scope = s.scope,
    active = s.activeTurn,
    replyOpen = s.capabilities.replyInteraction;
  return pending.flatMap((p) => {
    const r = p.codexAcp;
    if (
      !r ||
      !r.scope ||
      !r.context?.thread ||
      !r.request?.nativeRequest?.params ||
      p.kind !== "codex_native" ||
      p.runtime.productId !== scope.runtimeProductId ||
      p.runtime.adapterId !== scope.adapterId ||
      p.runtime.installationId !== scope.installationId ||
      p.runtimeGeneration !== scope.generation ||
      p.nativeSessionId !== s.target!.nativeThreadId ||
      !sameCodexAcpScope(r.scope, scope) ||
      !sameCodexAcpContext(r.context, active.context) ||
      r.nativeTurnId !== active.nativeTurnId ||
      r.request.turnId !== active.nativeTurnId ||
      r.request.threadId !== s.target!.nativeThreadId ||
      r.request.key !== p.interactionId ||
      r.request.nativeRequest.method !== r.request.method ||
      r.request.nativeRequest.params.threadId !== r.request.threadId ||
      r.request.nativeRequest.params.turnId !== r.request.turnId ||
      r.request.nativeRequest.params.itemId !== r.request.itemId ||
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
      ].includes(r.request.method) ||
      (r.request.method === "item/tool/requestUserInput" &&
        r.nativeMode !== "plan")
    )
      return [];
    // When replies are open the native command/path/diff payloads must render
    // so the user can decide; closed replies still keep only reply identity.
    const request = replyOpen ? r.request : closedCodexAcpRequest(r.request);
    const safePending: HostPendingInteraction = {
      ...p,
      codexAcp: {
        ...r,
        request,
        fileChanges: replyOpen ? r.fileChanges : null,
      },
    };
    return [
      {
        key: JSON.stringify([
          scope,
          r.context,
          r.nativeTurnId,
          r.request.nativeRequest.id,
          p.interactionId,
        ]),
        pending: safePending,
        request,
        target: {
          farfoldSessionId: s.target!.farfoldSessionId,
          nativeSessionId: s.target!.nativeThreadId,
          generation: scope.generation,
        },
        fileChanges: replyOpen ? (r.fileChanges ?? undefined) : undefined,
        unavailableReason: s.capabilities.replyInteraction
          ? undefined
          : "原生交互回复当前不可用；不会自动批准",
      },
    ];
  });
}

/** Presentation mapper only. No second transcript reducer, native state or admission owner. */
export function codexWorkspaceView(input: {
  binding: HostSessionBinding | null;
  acp: CodexAcpWorkspaceSnapshot | null;
  acpTranscript?: AcpTranscript | null;
  pending: HostPendingInteraction[];
  observed: readonly CodexObservedEvent[];
}) {
  const { binding, pending, observed } = input;
  const acp =
    input.acp && codexAcpSnapshotMatches(input.acp, binding) ? input.acp : null;
  const route = codexWorkspaceRoute(binding);
  const connected = route === "acp" && acp?.connectionState === "connected";
  return {
    route,
    connected,
    session: binding,
    connectionLabel: acp
      ? codexAcpWorkspaceLabel(acp)
      : "Codex ACP 状态尚未核对",
    modelLabel: acp?.admission?.actual
      ? `上次确认：${acp.admission.actual.nativeModel} · ${acp.admission.actual.reasoningEffort}`
      : "ACP 模型尚未确认",
    accountLabel: acp?.admission?.account
      ? `上次账号观察：${acp.admission.account.kind}；不保证本轮可用`
      : "账号尚未确认",
    selectionLabel: acp?.admission?.selection
      ? `${acp.admission.selection.catalogModelId} → ${acp.admission.selection.nativeModel} · ${acp.admission.selection.provider} · ${acp.admission.selection.reasoningEffort}`
      : "尚未显式选择模型",
    acpTranscript:
      route === "acp" && acp ? (input.acpTranscript ?? null) : null,
    historySummary: `完整原生历史尚未恢复。本连接已观察 ${observed.length} 条匹配的原生事件；事件摘要不代表完整历史或任务结束。`,
    activeTurn: acp?.activeTurn
      ? {
          hostTurnId: acp.activeTurn.context.hostTurnId,
          nativeTurnId: acp.activeTurn.nativeTurnId,
        }
      : null,
    interactions: acp ? acpInteractions(pending, acp) : [],
    capabilities: {
      send: route === "acp" && (acp?.capabilities.submitTurn ?? false),
      reply: route === "acp" && (acp?.capabilities.replyInteraction ?? false),
      stop: route === "acp" && (acp?.capabilities.interrupt ?? false),
      steer: route === "acp" && (acp?.capabilities.steer ?? false),
    },
  };
}
