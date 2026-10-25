/**
 * 产物窗格卡片。
 * 产物卡由 tool_call 更新内容推导（diff 内容、execute 调用输出），
 * 只活在内存里，不进 meta_store、不做事件账本。
 * 这里仅放对 ThreadState 的纯操作；ThreadState 经 `import type`
 * 反向引用，不产生运行时循环依赖。
 */
import type { ThreadState, ToolCallView, ToolContent } from "./session_types";

/** 命令卡输出上限：保留尾部 ~64KB。 */
export const COMMAND_OUTPUT_CAP = 64 * 1024;

/**
 * One row in the artifact drawer. `diff` cards come from `tool_call`
 * content with `type:"diff"`; `command` cards cover tool calls whose
 * `kind === "execute"` and carry the call's captured output.
 */
export type PaneCard =
  | {
      kind: "diff";
      path: string;
      oldText: string | null;
      newText: string;
      /** Coordinate scope; protocol diffs do not establish full-file contents or offsets. */
      scope: "file" | "fragment";
      source: "diff" | "write-input" | "edit-input";
      status: string;
      time: number;
    }
  | {
      kind: "command";
      title: string;
      output: string;
      failed: boolean;
      time: number;
    }
  | {
      kind: "log";
      title: string;
      output: string;
      failed: boolean;
      time: number;
    };

/** Prefer nonempty terminal/raw output (a string or an object's `output` field),
 *  then the concatenated `text` content. Empty placeholders must not hide an
 *  actual text result. Capped to the last
 *  [`COMMAND_OUTPUT_CAP`] bytes-ish (chars). */
function commandOutput(call: ToolCallView): string {
  if (call.terminalOutput) return call.terminalOutput;
  const raw = call.rawOutput;
  let text: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object") {
    const output = (raw as { output?: unknown }).output;
    if (typeof output === "string") text = output;
  }
  if (text === null || text.length === 0) {
    text = call.content
      .filter(
        (c): c is Extract<ToolContent, { type: "text" }> => c.type === "text",
      )
      .map((c) => c.text)
      .join("");
  }
  return text.length > COMMAND_OUTPUT_CAP
    ? text.slice(-COMMAND_OUTPUT_CAP)
    : text;
}

/** Normalized passive output; verify tool/terminal ownership before appending. */
export function appendToolOutput(
  s: ThreadState,
  event: Record<string, unknown>,
): void {
  const item = s.items.find(
    (i) => i.kind === "tool" && i.call.toolCallId === event.toolCallId,
  );
  if (item?.kind !== "tool" || typeof event.data !== "string") return;
  if (
    !item.call.content.some(
      (c) => c.type === "terminal" && c.terminalId === event.terminalId,
    )
  )
    return;
  item.call.terminalOutput = (
    (item.call.terminalOutput ?? "") + event.data
  ).slice(-COMMAND_OUTPUT_CAP);
}

/** Some agents report an edit/write call without a `type:"diff"` content
 *  block; the input arguments still carry the change (`filePath` +
 *  `content`, or `oldString`/`newString`). Synthesize a card so the
 *  artifact drawer reflects every reported file write. */
function synthesizedDiff(call: ToolCallView): PaneCard | null {
  if (call.kind !== "edit") return null;
  if (call.content.some((c) => c.type === "diff")) return null;
  const input = call.rawInput as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return null;
  const path =
    (typeof input.filePath === "string" && input.filePath) ||
    (typeof input.path === "string" && input.path) ||
    call.locations[0]?.path ||
    "";
  if (!path) return null;
  const newText =
    typeof input.newString === "string"
      ? input.newString
      : typeof input.content === "string"
        ? input.content
        : null;
  if (newText === null) return null;
  const oldText = typeof input.oldString === "string" ? input.oldString : null;
  return {
    kind: "diff",
    path,
    oldText,
    newText,
    scope: "fragment",
    source: typeof input.newString === "string" ? "edit-input" : "write-input",
    status: call.status,
    time: call.endedAt ?? call.startedAt,
  };
}

/** Cards for the artifact drawer, oldest first. `items` is sliced to
 *  `fromItem` when only the latest round is wanted. */
export function paneCards(s: ThreadState, fromItem = 0): PaneCard[] {
  const cards: PaneCard[] = [];
  for (const item of s.items.slice(fromItem)) {
    if (item.kind !== "tool") continue;
    const time = item.call.endedAt ?? item.call.startedAt;
    if (item.call.kind === "execute") {
      cards.push({
        kind: "command",
        title: item.call.title || item.call.name || "",
        output: commandOutput(item.call),
        failed: item.call.status === "failed",
        time,
      });
    }
    if (item.call.kind !== "execute") {
      const output = commandOutput(item.call);
      if (output)
        cards.push({
          kind: "log",
          title: item.call.title || item.call.name || "",
          output,
          failed: item.call.status === "failed",
          time,
        });
    }
    for (const c of item.call.content) {
      if (c.type === "diff") {
        cards.push({
          kind: "diff",
          path: c.path,
          oldText: c.oldText,
          newText: c.newText,
          // Diffs can contain replacement snippets. Neither the content type nor
          // a tool's location establishes a full file or either side's line offset.
          scope: "fragment",
          source: "diff",
          status: item.call.status,
          time,
        });
      }
    }
    const synthesized = synthesizedDiff(item.call);
    if (synthesized) cards.push(synthesized);
  }
  return cards.sort((a, b) => a.time - b.time);
}

/** Diff/command cards produced during the current/last round. */
export function roundArtifactCount(s: ThreadState): number {
  return paneCards(s, s.roundItemBase).length;
}
