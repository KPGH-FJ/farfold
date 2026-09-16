import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpScope } from "./codex-acp-contract";
import {
  sameCodexAcpScope,
  type CodexAcpWorkspaceSnapshot,
} from "./codex-acp-workspace";
import { object } from "./codex-conversation";
import {
  runtimeEnvelopeFromHostEvent,
  type HostEventCursor,
  type HostRoutedEvent,
} from "./host-shadow";

export type AcpContentItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "commandExecution" | "fileChange"; id: string; status: string };
export interface AcpHistoryTurn {
  nativeTurnId: string;
  status: "completed" | "failed" | "interrupted";
  items: AcpContentItem[];
}
export interface AcpHistory {
  scope: CodexAcpScope;
  farfoldSessionId: string;
  nativeThreadId: string;
  nativeTreeId: string;
  before: HostEventCursor;
  turns: AcpHistoryTurn[];
}
export type AcpContentPayload =
  | { kind: "started" }
  | { kind: "terminal"; status: AcpHistoryTurn["status"] }
  | { kind: "item_started" | "item_completed"; item: AcpContentItem }
  | {
      kind: "delta";
      itemId: string;
      channel: string;
      delta: string;
      index: number | null;
    };
export interface AcpContentEvent {
  sequence: number;
  hostTurnId: string;
  nativeTurnId: string;
  payload: AcpContentPayload;
}
export const contentId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
const itemId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
export const nativeId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const boundedText = (v: unknown): v is string =>
  typeof v === "string" && new TextEncoder().encode(v).length <= 65536;
export const sequence = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
export function fields(
  v: unknown,
  names: string[],
): v is Record<string, unknown> {
  return (
    !!object(v) &&
    Object.keys(v as object).length === names.length &&
    names.every((n) => Object.hasOwn(v as object, n))
  );
}
const terminal = (v: unknown): v is AcpHistoryTurn["status"] =>
  ["completed", "failed", "interrupted"].includes(String(v));
const invalid = () =>
  new Error(
    "原会话历史尚未核对；不会重发任务。仅展示有界内容，原生详情可能缺失。",
  );
export function checkedItem(raw: unknown): AcpContentItem {
  const r = object(raw);
  if (!r || !itemId(r.id)) throw invalid();
  if (
    r.type === "agentMessage" &&
    fields(r, ["type", "id", "text"]) &&
    boundedText(r.text)
  )
    return { type: r.type, id: r.id, text: r.text };
  if (
    r.type === "reasoning" &&
    fields(r, ["type", "id", "summary", "content"]) &&
    [r.summary, r.content].every(
      (a) => Array.isArray(a) && a.length <= 64 && a.every(boundedText),
    )
  )
    return {
      type: r.type,
      id: r.id,
      summary: [...(r.summary as string[])],
      content: [...(r.content as string[])],
    };
  if (
    (r.type === "commandExecution" || r.type === "fileChange") &&
    fields(r, ["type", "id", "status"]) &&
    ["inProgress", "completed", "failed", "declined"].includes(String(r.status))
  )
    return { type: r.type, id: r.id, status: String(r.status) };
  throw invalid();
}
export async function requestCodexAcpHistory(
  scope: CodexAcpScope,
  farfoldSessionId: string,
): Promise<AcpHistory> {
  const original = { ...scope };
  if (!contentId(farfoldSessionId)) throw invalid();
  let raw: unknown;
  try {
    raw = await invoke("host_codex_acp_operation", {
      input: { action: "history", scope: original, farfoldSessionId },
    });
  } catch {
    throw invalid();
  }
  if (
    !fields(raw, ["kind", "snapshot"]) ||
    raw.kind !== "history" ||
    !fields(raw.snapshot, [
      "scope",
      "farfoldSessionId",
      "nativeThreadId",
      "nativeTreeId",
      "before",
      "turns",
    ])
  )
    throw invalid();
  const r = raw.snapshot,
    b = object(r.before);
  if (
    !object(r.scope) ||
    !sameCodexAcpScope(r.scope as CodexAcpScope, original) ||
    r.farfoldSessionId !== farfoldSessionId ||
    !nativeId(r.nativeThreadId) ||
    !nativeId(r.nativeTreeId) ||
    !b ||
    !fields(b, [
      "streamId",
      "latestSequence",
      "oldestAvailable",
      "droppedTotal",
    ]) ||
    !contentId(b.streamId) ||
    !sequence(b.latestSequence) ||
    !sequence(b.droppedTotal) ||
    (b.oldestAvailable !== null && !sequence(b.oldestAvailable)) ||
    !Array.isArray(r.turns) ||
    r.turns.length > 64 ||
    JSON.stringify(r.turns).length > 2 * 1024 * 1024
  )
    throw invalid();
  const ids = new Set<string>();
  let count = 0;
  const turns = r.turns.map((t: unknown): AcpHistoryTurn => {
    if (
      !fields(t, ["nativeTurnId", "status", "items"]) ||
      !nativeId(t.nativeTurnId) ||
      ids.has(t.nativeTurnId) ||
      !terminal(t.status) ||
      !Array.isArray(t.items) ||
      t.items.length > 256
    )
      throw invalid();
    ids.add(t.nativeTurnId);
    const items = t.items.map(checkedItem);
    count += items.length;
    if (
      new Set(items.map((i) => i.id)).size !== items.length ||
      items.some((i) => "status" in i && i.status === "inProgress") ||
      count > 500
    )
      throw invalid();
    return { nativeTurnId: t.nativeTurnId, status: t.status, items };
  });
  return {
    scope: original,
    farfoldSessionId,
    nativeThreadId: r.nativeThreadId,
    nativeTreeId: r.nativeTreeId,
    before: {
      streamId: b.streamId,
      latestSequence: b.latestSequence,
      oldestAvailable: b.oldestAvailable as number | null,
      droppedTotal: b.droppedTotal,
    },
    turns,
  };
}

/** Only exact current scoped content is retained. Raw/private envelopes never enter the view buffer. */
export function contentEvent(
  e: HostRoutedEvent,
  s: CodexAcpWorkspaceSnapshot,
): AcpContentEvent | null {
  const scope = s.scope,
    t = s.target;
  if (!scope || !t) throw invalid();
  if (
    e.runtime.productId !== scope.runtimeProductId ||
    e.runtime.adapterId !== scope.adapterId ||
    e.runtime.installationId !== scope.installationId ||
    e.runtimeBuildId !== scope.runtimeBuildId ||
    e.connectionId !== scope.connectionId ||
    e.runtimeGeneration !== scope.generation
  )
    return null;
  if (
    e.preservation !== "native" ||
    ["transport_error", "transport_gap"].includes(e.kind)
  )
    throw invalid();
  if (e.kind !== "acp") return null;
  const raw = object(runtimeEnvelopeFromHostEvent(e)?.payload),
    p = object(raw?.params);
  if (raw?.method === "_codex/thread/event") return null;
  if (
    raw?.method !== "_codex/turn/event" ||
    !p ||
    !object(p.scope) ||
    !sameCodexAcpScope(p.scope as CodexAcpScope, scope)
  )
    throw invalid();
  const r = object(p.turn),
    c = object(r?.context),
    thread = object(c?.thread);
  if (
    !r ||
    !c ||
    !thread ||
    c.farfoldSessionId !== t.farfoldSessionId ||
    c.workingCopyId !== t.workingCopyId ||
    thread.nativeThreadId !== t.nativeThreadId ||
    thread.nativeSessionId !== t.nativeTreeId ||
    thread.cwd !== t.cwd ||
    !contentId(c.hostTurnId) ||
    !nativeId(r.nativeTurnId)
  )
    throw invalid();
  let payload: AcpContentPayload;
  if (r.kind === "started" && fields(r, ["context", "nativeTurnId", "kind"]))
    payload = { kind: "started" };
  else if (
    r.kind === "terminal" &&
    fields(r, ["context", "nativeTurnId", "kind", "status"]) &&
    terminal(r.status)
  )
    payload = { kind: "terminal", status: r.status };
  else if (
    (r.kind === "item_started" || r.kind === "item_completed") &&
    fields(r, ["context", "nativeTurnId", "kind", "item"])
  )
    payload = { kind: r.kind, item: checkedItem(r.item) };
  else if (
    r.kind === "delta" &&
    fields(r, [
      "context",
      "nativeTurnId",
      "kind",
      "itemId",
      "channel",
      "delta",
      "index",
    ]) &&
    itemId(r.itemId) &&
    boundedText(r.delta) &&
    ((r.channel === "item/agentMessage/delta" && r.index === null) ||
      (["item/reasoning/textDelta", "item/reasoning/summaryTextDelta"].includes(
        String(r.channel),
      ) &&
        sequence(r.index) &&
        r.index < 64))
  )
    payload = {
      kind: "delta",
      itemId: r.itemId,
      channel: String(r.channel),
      delta: r.delta,
      index: r.index as number | null,
    };
  else if (r.kind === "interaction_open" || r.kind === "interaction_end")
    return null;
  else throw invalid();
  return {
    sequence: e.sequence,
    hostTurnId: c.hostTurnId,
    nativeTurnId: r.nativeTurnId,
    payload,
  };
}
