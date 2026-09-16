import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpWorkspaceSnapshot } from "./codex-acp-workspace";
import { sameCodexAcpScope } from "./codex-acp-workspace";
import type { HostEventBatch } from "./host-shadow";
import {
  contentEvent,
  contentId,
  sequence,
  type AcpContentEvent,
  type AcpContentItem,
  type AcpHistory,
} from "./codex-acp-content";

export interface AcpTranscriptTurn {
  nativeTurnId: string;
  hostTurnId: string | null;
  source: "history" | "live";
  status: string;
  items: AcpContentItem[];
}
export interface AcpTranscript {
  turns: AcpTranscriptTurn[];
  incomplete: boolean;
  notice: string;
}
const limitations =
  "有限只读内容：用户输入、命令全文、输出及差异可能未恢复；原生状态观察不等于 Host 任务结算。";
export function projectAcpTranscript(
  history: AcpHistory | null,
  events: readonly AcpContentEvent[],
  incomplete: boolean,
  notice: string,
): AcpTranscript {
  const turns: AcpTranscriptTurn[] = (history?.turns ?? []).map((t) => ({
    ...t,
    items: t.items.map((i) => structuredClone(i)),
    hostTurnId: null,
    source: "history",
  }));
  const historical = new Set(turns.map((t) => t.nativeTurnId));
  const seen = new Map<number, string>(),
    hostToNative = new Map<string, string>();
  for (const e of events) {
    const serialized = JSON.stringify(e);
    if (seen.has(e.sequence)) {
      if (seen.get(e.sequence) !== serialized) incomplete = true;
      continue;
    }
    seen.set(e.sequence, serialized);
    if (
      hostToNative.has(e.hostTurnId) &&
      hostToNative.get(e.hostTurnId) !== e.nativeTurnId
    ) {
      incomplete = true;
      continue;
    }
    hostToNative.set(e.hostTurnId, e.nativeTurnId);
    if (historical.has(e.nativeTurnId)) continue; // Terminal native history supersedes overlapping live content.
    let turn = turns.find((t) => t.nativeTurnId === e.nativeTurnId);
    if (turn && turn.hostTurnId !== e.hostTurnId) {
      incomplete = true;
      continue;
    }
    if (!turn) {
      turn = {
        nativeTurnId: e.nativeTurnId,
        hostTurnId: e.hostTurnId,
        source: "live",
        status: "unconfirmed",
        items: [],
      };
      turns.push(turn);
      if (e.payload.kind !== "started") incomplete = true;
    }
    const p = e.payload;
    if (p.kind === "started") {
      if (turn.status === "unconfirmed") turn.status = "inProgress";
      continue;
    }
    if (p.kind === "terminal") {
      turn.status = p.status;
      continue;
    }
    if (["completed", "failed", "interrupted"].includes(turn.status)) {
      incomplete = true;
      continue;
    }
    if (p.kind === "item_started" || p.kind === "item_completed") {
      const index = turn.items.findIndex((i) => i.id === p.item.id);
      if (index < 0) turn.items.push(structuredClone(p.item));
      else if (p.kind === "item_completed")
        turn.items[index] = structuredClone(p.item);
      else if (JSON.stringify(turn.items[index]) !== JSON.stringify(p.item))
        incomplete = true;
      continue;
    }
    if (p.kind === "delta") {
      const item = turn.items.find((i) => i.id === p.itemId);
      if (
        item?.type === "agentMessage" &&
        p.channel === "item/agentMessage/delta"
      )
        item.text += p.delta;
      else if (item?.type === "reasoning" && p.index !== null) {
        const parts =
          p.channel === "item/reasoning/summaryTextDelta"
            ? item.summary
            : item.content;
        while (parts.length <= p.index) parts.push("");
        parts[p.index] += p.delta;
      } else incomplete = true;
    }
  }
  if (
    turns.length > 64 ||
    turns.reduce((n, t) => n + t.items.length, 0) > 500 ||
    JSON.stringify(turns).length > 4 * 1024 * 1024
  ) {
    return {
      turns: turns.slice(-8).map((t) => ({ ...t, items: t.items.slice(-8) })),
      incomplete: true,
      notice: `显示缓冲已裁剪，不代表任务取消。${limitations}`,
    };
  }
  return { turns, incomplete, notice: `${notice} ${limitations}` };
}

/** Bounded view cache only: pure projection of an exact baseline plus safe router events.
 * No native event drain, task admission, settlement, persistent ledger or prompt replay. */
export class CodexAcpTranscriptReader {
  private revision = 0;
  retire() {
    ++this.revision;
  }
  private key = "";
  private history: AcpHistory | null = null;
  private events: AcpContentEvent[] = [];
  private stream: string | null = null;
  private after = 0;
  private partial = false;
  private blocked = false;
  private attempted: string | null = null;
  private terminal: string | null = null;
  private reason = "历史尚未读取";
  async read(
    snapshot: CodexAcpWorkspaceSnapshot,
    readHistory: () => Promise<AcpHistory>,
  ): Promise<AcpTranscript> {
    const revision = ++this.revision;
    const current = () => revision === this.revision;
    const requireCurrent = () => {
      if (!current()) throw new Error("正文读取目标已退休");
    };
    const s = snapshot.scope,
      t = snapshot.target;
    const key = JSON.stringify([s, t]);
    if (key !== this.key) {
      this.key = key;
      this.history = null;
      this.events = [];
      this.stream = null;
      this.after = 0;
      this.partial = false;
      this.blocked = false;
      this.attempted = null;
      this.terminal = null;
      this.reason = "历史尚未读取";
    }
    if (!s || !t || snapshot.connectionState !== "connected") {
      this.partial = true;
      return projectAcpTranscript(
        this.history,
        this.events,
        true,
        "连接状态无法确认；以下仅为原目标上次已观察内容，不再拼接。未观察到任务取消。",
      );
    }
    if (this.blocked)
      return projectAcpTranscript(this.history, this.events, true, this.reason);
    const checkpoint = this.terminal ?? "initial";
    if (!snapshot.activeTurn && this.attempted !== checkpoint) {
      this.attempted = checkpoint;
      try {
        const h = await readHistory();
        requireCurrent();
        if (
          !sameCodexAcpScope(h.scope, s) ||
          h.farfoldSessionId !== t.farfoldSessionId ||
          h.nativeThreadId !== t.nativeThreadId ||
          h.nativeTreeId !== t.nativeTreeId
        )
          throw new Error("mismatch");
        this.history = h;
        this.events = [];
        this.stream = h.before.streamId;
        this.after = h.before.latestSequence;
        this.partial = false;
        this.reason =
          "已读取原会话的有限历史；实时输出从读取前的共享事件游标接续。";
      } catch {
        requireCurrent();
        this.partial = true;
        this.reason =
          "历史未能核对；仅展示本连接可验证的事件，不自动重发任务。";
      }
    }
    const after = this.after;
    let b: HostEventBatch;
    try {
      b = await invoke("runtime_event_snapshot", {
        afterSequence: after,
        limit: 512,
      });
    } catch {
      requireCurrent();
      this.partial = true;
      this.blocked = true;
      this.reason = "共享事件读取失败，已停止拼接；任务状态未被此视图改变。";
      return projectAcpTranscript(this.history, this.events, true, this.reason);
    }
    requireCurrent();
    if (
      !b ||
      !contentId(b.streamId) ||
      !sequence(b.nextAfter) ||
      !sequence(b.latestSequence) ||
      b.requestedAfter !== after ||
      !Array.isArray(b.events) ||
      b.events.length > 512 ||
      b.nextAfter > b.latestSequence ||
      b.nextAfter < after ||
      typeof b.hasMore !== "boolean" ||
      b.hasMore !== b.nextAfter < b.latestSequence ||
      (this.stream !== null && b.streamId !== this.stream)
    ) {
      this.partial = true;
      this.blocked = true;
      this.reason = "事件流或游标已变化，已停止拼接；请重新核对原会话。";
      return projectAcpTranscript(this.history, this.events, true, this.reason);
    }
    this.stream = b.streamId;
    if (b.gap) {
      this.partial = true;
      this.reason = "共享事件存在缺口，当前内容不能视为连续历史。";
    }
    let expected = after;
    for (const e of b.events) {
      if (
        !e ||
        !sequence(e.sequence) ||
        e.streamId !== b.streamId ||
        !e.runtime ||
        e.sequence > b.nextAfter
      ) {
        this.partial = true;
        continue;
      }
      if (e.sequence <= expected) continue;
      if (e.sequence !== expected + 1) this.partial = true;
      expected = e.sequence;
      try {
        const content = contentEvent(e, snapshot);
        if (content) {
          this.events.push(content);
          if (content.payload.kind === "terminal")
            this.terminal = content.nativeTurnId;
        }
      } catch {
        this.partial = true;
        this.reason =
          "事件身份、内容或连接无法核对；已保留可验证片段，不声明完整历史。";
      }
    }
    if (expected !== b.nextAfter) {
      this.partial = true;
      this.blocked = true;
      this.reason = "事件批次游标不连续，已停止拼接。";
    }
    this.after = b.nextAfter;
    while (
      this.events.length > 512 ||
      JSON.stringify(this.events).length > 2 * 1024 * 1024
    ) {
      this.events.shift();
      this.partial = true;
      this.reason = "实时显示缓冲已裁剪，不代表任务取消。";
    }
    return projectAcpTranscript(
      this.history,
      this.events,
      this.partial || !this.history || b.hasMore,
      b.hasMore ? "正在读取有界事件片段，尚未追上当前游标。" : this.reason,
    );
  }
}
