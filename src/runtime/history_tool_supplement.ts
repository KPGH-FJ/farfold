import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import type { ThreadItem, ThreadState, ToolContent } from "./session_types";
import { STRINGS } from "./strings";

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const ownerKeys = ["kind", "openToken", "connectionId", "sessionId", "cwd"];
const MAX_BYTES = 8 * 1024 * 1024;
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !v.includes("\0");

type HistoryAnchor = { role: "user" | "assistant"; text: string };
type PreparedTool = {
  gap: number;
  resultGap: number;
  item: Extract<ThreadItem, { kind: "tool" }>;
};
type PreparedSupplement = {
  tools: PreparedTool[];
  splits: Map<ThreadItem, [string, string]>;
};

function isHistoryAnchor(value: unknown): value is HistoryAnchor {
  return (
    record(value) &&
    exact(value, ["role", "text"]) &&
    (value.role === "user" || value.role === "assistant") &&
    string(value.text)
  );
}

export function isOwnedHistoryToolSupplement(
  state: ThreadState,
  event: unknown,
  token: string,
): boolean {
  if (
    !record(event) ||
    Object.hasOwn(event, "update") ||
    !["historyToolSupplement", "historyToolSupplementStatus"].includes(
      String(event.kind),
    ) ||
    event.openToken !== token ||
    !state.connectionId ||
    event.connectionId !== state.connectionId ||
    event.sessionId !== state.nativeSessionId ||
    event.cwd !== state.cwd ||
    state.connectionLost
  )
    return false;
  const status = event.kind === "historyToolSupplementStatus";
  return (
    exact(event, [
      ...ownerKeys,
      ...(status ? ["reason"] : ["anchors", "tools"]),
    ]) &&
    (!status ||
      ["unavailable", "changed", "invalid", "limit", "cancelled"].includes(
        String(event.reason),
      ))
  );
}

function notice(state: ThreadState, message: string) {
  state.items.push({
    kind: "notice",
    id: crypto.randomUUID(),
    message,
    time: 0,
  });
}

/** Retain at most one bounded result while waiting for the original marker. */
export function boundedHistoryToolSupplement(event: unknown): unknown {
  if (!record(event)) return;
  try {
    if (new TextEncoder().encode(JSON.stringify(event)).length <= MAX_BYTES)
      return event;
  } catch {
    // Native delivery is JSON. A non-JSON fixture has no supplementary authority.
  }
  return {
    kind: "historyToolSupplementStatus",
    openToken: event.openToken,
    connectionId: event.connectionId,
    sessionId: event.sessionId,
    cwd: event.cwd,
    reason: "limit",
  };
}

/** Called only by the owning cold-open before its history marker. These are
 * official-export records, never synthetic ACP updates or live tool actions.
 * All validation finishes before the existing private view is changed. */
export function applyHistoryToolSupplement(
  state: ThreadState,
  event: unknown,
  token: string,
): boolean {
  if (!record(event) || !isOwnedHistoryToolSupplement(state, event, token))
    return false;
  const status = event.kind === "historyToolSupplementStatus";
  if (
    !exact(event, [
      ...ownerKeys,
      ...(status ? ["reason"] : ["anchors", "tools"]),
    ])
  )
    return false;
  if (status) {
    if (
      !["unavailable", "changed", "invalid", "limit", "cancelled"].includes(
        String(event.reason),
      )
    )
      return false;
    notice(state, STRINGS.historySupplement.partial);
    return true;
  }
  // Future official replay stays authoritative, including partial tool replay.
  if (state.items.some((item) => item.kind === "tool")) return true;
  let prepared: PreparedSupplement | undefined;
  try {
    if (new TextEncoder().encode(JSON.stringify(event)).length <= MAX_BYTES)
      prepared = prepare(state, event.anchors, event.tools);
  } catch {
    // A malformed local payload cannot damage the readable ACP prefix.
  }
  if (!prepared) {
    notice(state, STRINGS.historySupplement.partial);
    return true;
  }
  const { tools, splits } = prepared;
  if (!tools.length) return true;
  const original = state.items;
  const merged: ThreadItem[] = [];
  let anchors = 0;
  let tool = 0;
  const insert = () => {
    while (tool < tools.length && tools[tool].gap === anchors)
      merged.push(tools[tool++].item);
  };
  insert();
  for (const item of original) {
    const split = splits.get(item);
    if (split && item.kind === "user") {
      merged.push({ ...item, text: split[0] });
      anchors++;
      insert();
      merged.push({
        kind: "user",
        id: crypto.randomUUID(),
        text: split[1],
        attachments: [],
        streaming: false,
        time: item.time,
      });
    } else {
      merged.push(item);
    }
    if ((item.kind === "user" || item.kind === "agent") && item.text.length) {
      anchors++;
      insert();
    }
  }
  state.items = merged;
  notice(state, STRINGS.historySupplement.snapshot);
  return true;
}

function prepare(
  state: ThreadState,
  anchors: unknown,
  rawTools: unknown,
): PreparedSupplement | undefined {
  if (
    !Array.isArray(anchors) ||
    !Array.isArray(rawTools) ||
    !anchors.length ||
    anchors.length > 20_000 ||
    rawTools.length > 2_000 ||
    !anchors.every(isHistoryAnchor)
  )
    return;
  const ids = new Set<string>();
  let lastGap = 0;
  const tools: PreparedTool[] = [];
  for (const tool of rawTools) {
    if (
      !record(tool) ||
      !exact(tool, [
        "toolCallId",
        "name",
        "arguments",
        "callAfterAnchor",
        "resultAfterAnchor",
        "outcome",
        "content",
        "rawCall",
        "rawResult",
      ]) ||
      !string(tool.toolCallId) ||
      !string(tool.name) ||
      ids.has(tool.toolCallId) ||
      !record(tool.arguments) ||
      !record(tool.rawCall) ||
      !record(tool.rawResult) ||
      !["success", "error"].includes(String(tool.outcome)) ||
      !Number.isSafeInteger(tool.callAfterAnchor) ||
      !Number.isSafeInteger(tool.resultAfterAnchor) ||
      typeof tool.callAfterAnchor !== "number" ||
      typeof tool.resultAfterAnchor !== "number" ||
      tool.callAfterAnchor < lastGap ||
      tool.resultAfterAnchor < tool.callAfterAnchor ||
      tool.resultAfterAnchor > anchors.length ||
      !Array.isArray(tool.content) ||
      tool.content.length > 64
    )
      return;
    ids.add(tool.toolCallId);
    lastGap = tool.callAfterAnchor;
    const content: ToolContent[] = [];
    for (const block of tool.content) {
      if (!record(block)) return;
      if (
        block.type === "text" &&
        exact(block, ["type", "text"]) &&
        typeof block.text === "string"
      ) {
        content.push({ type: "text", text: block.text });
      } else if (
        block.type === "image" &&
        exact(block, ["type", "mimeType", "data"]) &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      ) {
        const attachment = normalizeMessageAttachment(block);
        if (
          !attachment ||
          attachmentMediaAdmission(attachment).status !== "available"
        )
          return;
        content.push({ type: "attachment", attachment });
      } else return;
    }
    tools.push({
      gap: tool.callAfterAnchor,
      resultGap: tool.resultAfterAnchor,
      item: {
        kind: "tool",
        id: crypto.randomUUID(),
        call: {
          toolCallId: tool.toolCallId,
          name: tool.name,
          title: STRINGS.historySupplement.tool,
          kind: "other",
          status: tool.outcome === "success" ? "completed" : "failed",
          startedAt: 0,
          locations: [],
          content,
          rawInput: tool.arguments,
          rawOutput: {
            source: "officialHistoryExport",
            call: tool.rawCall,
            result: tool.rawResult,
          },
        },
      },
    });
  }
  const splits = alignHistoryAnchors(state.items, anchors, tools);
  if (splits) return { tools, splits };
}

function alignHistoryAnchors(
  items: ThreadItem[],
  anchors: HistoryAnchor[],
  tools: PreparedTool[],
) {
  const splits = new Map<ThreadItem, [string, string]>();
  let index = 0;
  for (const item of items) {
    if ((item.kind !== "user" && item.kind !== "agent") || !item.text) continue;
    const first = anchors[index];
    if (first?.role !== (item.kind === "user" ? "user" : "assistant")) return;
    if (first.text === item.text) {
      index++;
      continue;
    }
    const second = anchors[index + 1];
    if (
      item.kind !== "user" ||
      item.messageId !== undefined ||
      item.historyForkPoint ||
      item.attachments.length ||
      second?.role !== "user" ||
      first.text + second.text !== item.text
    )
      return;

    // Split only when the export independently places a single failed call
    // across this boundary and its text result is the second exact anchor.
    const afterFirst = index + 1;
    const afterSecond = index + 2;
    const crossing = tools.filter(
      (tool) => tool.gap === afterFirst || tool.resultGap === afterSecond,
    );
    const tool = crossing[0];
    const content = tool?.item.call.content;
    if (
      crossing.length !== 1 ||
      tool.gap !== afterFirst ||
      tool.resultGap !== afterSecond ||
      tool.item.call.status !== "failed" ||
      content?.length !== 1 ||
      content[0].type !== "text" ||
      content[0].text !== second.text
    )
      return;

    splits.set(item, [first.text, second.text]);
    index += 2;
  }
  if (index === anchors.length) return splits;
}
