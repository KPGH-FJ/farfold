/**
 * 产物窗格卡片与 elicitation 视图类型。
 * 产物卡由 tool_call 更新内容推导（diff 内容、execute 调用输出），
 * 只活在内存里，不进 meta_store、不做事件账本。
 * 这里仅放对 ThreadState 的纯操作；ThreadState 经 `import type`
 * 反向引用，不产生运行时循环依赖。
 */
import type { ThreadState, ToolCallView, ToolContent } from "./session_types";

/** `elicitation/create`（form 模式）待答复表单。 */
export interface ElicitationView {
  requestId: string;
  message: string;
  /** JSON Schema form fields，原样透传（unknown）。 */
  schema: Record<string, unknown> | null;
  toolCallId: string | null;
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
      time: number;
    }
  | { kind: "command"; title: string; output: string; time: number };

/** Printable output for an `execute` tool call: `rawOutput` (a string or
 *  an object with a string `output` field), else the concatenated text of
 *  the call's `text` content entries. Capped to the last
 *  [`COMMAND_OUTPUT_CAP`] bytes-ish (chars). */
function commandOutput(call: ToolCallView): string {
  const raw = call.rawOutput;
  let text: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (raw && typeof raw === "object") {
    const output = (raw as { output?: unknown }).output;
    if (typeof output === "string") text = output;
  }
  if (text === null) {
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
