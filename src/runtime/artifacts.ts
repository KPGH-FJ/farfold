/**
 * 产物/终端输出/elicitation：Farfold 自有事件（`{kind:"artifact"}` /
 * `{kind:"terminalOutput"}` / `{kind:"elicitation"}`）的视图类型与归一化。
 * 产物只活在内存与事件流里，不进 meta_store、不做事件账本。
 * 这里仅放对 ThreadState 的纯操作；ThreadState 经 `import type`
 * 反向引用，不产生运行时循环依赖。
 */
import type { ThreadState } from "./sessions";

/** `{kind:"artifact"}` 事件载体的运行时形状。 */
export type ArtifactView =
  | {
      type: "fileDiff";
      path: string;
      oldSize: number;
      newSize: number;
      diff: string;
      time: number;
    }
  | { type: "terminal"; terminalId: string; title: string; time: number };

/** terminal/* 输出的滚动尾部（有界，截断时置 truncated）。 */
export interface TerminalTail {
  text: string;
  truncated: boolean;
  exit: number | null;
}

/** `elicitation/create`（form 模式）待答复表单。 */
export interface ElicitationView {
  requestId: string;
  message: string;
  /** JSON Schema form fields，原样透传（unknown）。 */
  schema: Record<string, unknown> | null;
  toolCallId: string | null;
}

/** 终端输出尾部上限：256KB 文本滚动缓冲。 */
export const TERMINAL_TAIL_CAP = 256 * 1024;

/** `{kind:"artifact",artifact}` → ArtifactView；未知 type 返回 null。 */
export function normalizeArtifact(raw: unknown): ArtifactView | null {
  const a = raw as Record<string, unknown> | null;
  if (a?.type === "fileDiff") {
    return {
      type: "fileDiff",
      path: String(a.path ?? ""),
      oldSize: typeof a.oldSize === "number" ? a.oldSize : 0,
      newSize: typeof a.newSize === "number" ? a.newSize : 0,
      diff: String(a.diff ?? ""),
      time: typeof a.ts === "number" ? a.ts : Date.now(),
    };
  }
  if (a?.type === "terminal") {
    return {
      type: "terminal",
      terminalId: String(a.terminalId ?? ""),
      title: String(a.title ?? ""),
      time: typeof a.ts === "number" ? a.ts : Date.now(),
    };
  }
  return null;
}

/** `{kind:"terminalOutput",terminalId,data,exit?}` → 尾部追加。 */
export function applyTerminalOutput(
  s: ThreadState,
  event: Record<string, unknown>,
): void {
  const terminalId = String(event.terminalId ?? "");
  if (!terminalId) return;
  const tail: TerminalTail =
    s.terminalTails[terminalId] ??
    (s.terminalTails[terminalId] = {
      text: "",
      truncated: false,
      exit: null,
    });
  if (typeof event.data === "string" && event.data) {
    tail.text += event.data;
    if (tail.text.length > TERMINAL_TAIL_CAP) {
      tail.text = tail.text.slice(-TERMINAL_TAIL_CAP);
      tail.truncated = true;
    }
  }
  if (typeof event.exit === "number") tail.exit = event.exit;
  else if (event.exit != null) {
    const n = Number(event.exit);
    if (Number.isFinite(n)) tail.exit = n;
  }
}

/** `{kind:"elicitation",requestId,message,schema,toolCallId?}` → 待答复表单。 */
export function applyElicitation(
  s: ThreadState,
  event: Record<string, unknown>,
): void {
  const requestId = String(event.requestId ?? "");
  if (!requestId) return;
  s.pendingElicitation = {
    requestId,
    message: String(event.message ?? ""),
    schema:
      event.schema && typeof event.schema === "object"
        ? (event.schema as Record<string, unknown>)
        : null,
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : null,
  };
}

/**
 * One row in the artifact drawer. `diff` cards come from fs/write
 * artifacts (authoritative pre/post content); `toolDiff` cards cover
 * agent-reported `tool_call` diffs not already recorded as artifacts —
 * a fileDiff artifact wins on path collision because ours measured the
 * real bytes.
 */
export type PaneCard =
  | {
      kind: "diff";
      path: string;
      diff: string;
      oldSize: number;
      newSize: number;
      time: number;
    }
  | {
      kind: "toolDiff";
      path: string;
      oldText: string | null;
      newText: string;
      time: number;
    }
  | { kind: "terminal"; terminalId: string; title: string; time: number };

function artifactPaths(artifacts: ArtifactView[]): Set<string> {
  return new Set(
    artifacts.filter((a) => a.type === "fileDiff").map((a) => a.path),
  );
}

/** Cards for the artifact drawer, oldest first. `items` is sliced to
 *  `fromItem`/`fromArtifact` when only the latest round is wanted. */
export function paneCards(
  s: ThreadState,
  fromItem = 0,
  fromArtifact = 0,
): PaneCard[] {
  const covered = artifactPaths(s.artifacts.slice(fromArtifact));
  const cards: PaneCard[] = s.artifacts.slice(fromArtifact).map((a) =>
    a.type === "fileDiff"
      ? {
          kind: "diff",
          path: a.path,
          diff: a.diff,
          oldSize: a.oldSize,
          newSize: a.newSize,
          time: a.time,
        }
      : {
          kind: "terminal",
          terminalId: a.terminalId,
          title: a.title,
          time: a.time,
        },
  );
  for (const item of s.items.slice(fromItem)) {
    if (item.kind !== "tool") continue;
    for (const c of item.call.content) {
      if (c.type === "diff" && !covered.has(c.path)) {
        cards.push({
          kind: "toolDiff",
          path: c.path,
          oldText: c.oldText,
          newText: c.newText,
          time: item.call.endedAt ?? item.call.startedAt,
        });
      }
    }
  }
  return cards.sort((a, b) => a.time - b.time);
}

/** Artifacts recorded during the current/last round (deduped against
 *  tool-call diffs by path). */
export function roundArtifactCount(s: ThreadState): number {
  return paneCards(s, s.roundItemBase, s.roundArtifactBase).length;
}
