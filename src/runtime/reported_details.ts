import type { ThreadItem, ThreadState, ToolCallView } from "./session_types";
import { streamTailItem } from "./session_streams";

/** Last received value at each unconsumed field path, never an event history.
 * Values are opaque: an object, array or explicit null replaces that path.
 * Omission does not erase an earlier observation. No body is duplicated. */
export type ReportedDetails = Record<string, unknown>;
export interface ReportedDetailsOwner {
  reportedDetails?: ReportedDetails;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function path(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

const fields: Record<string, readonly string[]> = {
  user_message_chunk: ["messageId", "content"],
  agent_message_chunk: ["messageId", "content"],
  agent_thought_chunk: ["messageId", "content"],
  tool_call: [
    "toolCallId",
    "title",
    "name",
    "kind",
    "status",
    "content",
    "locations",
    "rawInput",
    "rawOutput",
  ],
  tool_call_update: [
    "toolCallId",
    "title",
    "name",
    "kind",
    "status",
    "content",
    "locations",
    "rawInput",
    "rawOutput",
  ],
  plan: ["entries"],
  available_commands_update: ["availableCommands"],
  config_option_update: ["configOptions"],
  current_mode_update: ["currentModeId"],
  session_info_update: ["title"],
  usage_update: ["used", "size", "cost"],
};

export function collectReportedDetails(
  update: unknown,
  envelope?: unknown,
): ReportedDetails {
  const details: ReportedDetails = {};
  const collect = (
    value: unknown,
    consumed: readonly string[],
    prefix: string,
  ) => {
    const object = record(value);
    if (!object) return;
    for (const [key, value] of Object.entries(object))
      if (!consumed.includes(key)) details[path(prefix, key)] = value;
  };
  const content = (value: unknown, prefix: string) => {
    const object = record(value);
    if (!object) return;
    switch (object.type) {
      case "text":
        collect(object, ["type", "text"], prefix);
        break;
      case "image":
      case "audio":
        collect(object, ["type", "data", "mimeType", "uri"], prefix);
        break;
      case "resource_link":
        collect(object, ["type", "name", "uri", "mimeType"], prefix);
        break;
      case "resource":
        collect(object, ["type", "resource"], prefix);
        collect(
          object.resource,
          ["uri", "text", "blob", "mimeType"],
          `${prefix}/resource`,
        );
        break;
      // An unrecognized block is already displayed whole in the raw view.
    }
  };
  const each = (
    value: unknown,
    visit: (value: unknown, prefix: string) => void,
    prefix: string,
  ) => {
    if (Array.isArray(value))
      value.forEach((entry, index) => visit(entry, `${prefix}/${index}`));
  };
  const option = (value: unknown, prefix: string) => {
    const object = record(value);
    if (!object) return;
    if (Array.isArray(object.options)) {
      collect(object, ["group", "name", "options"], prefix);
      each(object.options, option, `${prefix}/options`);
    } else collect(object, ["value", "name", "description"], prefix);
  };
  // The session route already retains unknown notifications whole. For known
  // updates, retain envelope extras independently from the normalized body.
  collect(envelope, ["sessionId", "update"], "");
  const u = record(update);
  const kind = typeof u?.sessionUpdate === "string" ? u.sessionUpdate : "";
  const consumed = Object.hasOwn(fields, kind) ? fields[kind] : undefined;
  if (!u || !consumed) return details;
  collect(u, ["sessionUpdate", ...consumed], "/update");
  if (kind.endsWith("_message_chunk") || kind === "agent_thought_chunk")
    content(u.content, "/update/content");
  if (kind === "tool_call" || kind === "tool_call_update") {
    each(
      u.content,
      (value, prefix) => {
        const c = record(value);
        if (c?.type === "content") {
          collect(c, ["type", "content"], prefix);
          content(c.content, `${prefix}/content`);
        } else if (c?.type === "diff")
          collect(c, ["type", "path", "oldText", "newText"], prefix);
        else if (c?.type === "terminal")
          collect(c, ["type", "terminalId"], prefix);
      },
      "/update/content",
    );
    each(
      u.locations,
      (value, prefix) => {
        // A malformed path is not consumed by the actionable location view.
        // Preserve its original shape in the existing opaque details surface.
        if (typeof record(value)?.path !== "string") details[prefix] = value;
        else collect(value, ["path", "line"], prefix);
      },
      "/update/locations",
    );
  }
  if (kind === "plan")
    each(
      u.entries,
      (value, prefix) =>
        collect(value, ["content", "priority", "status"], prefix),
      "/update/entries",
    );
  if (kind === "usage_update")
    collect(u.cost, ["amount", "currency"], "/update/cost");
  if (kind === "available_commands_update")
    each(
      u.availableCommands,
      (value, prefix) => {
        collect(value, ["name", "description", "input"], prefix);
        collect(record(value)?.input, ["hint"], `${prefix}/input`);
      },
      "/update/availableCommands",
    );
  if (kind === "config_option_update")
    each(
      u.configOptions,
      (value, prefix) => {
        collect(
          value,
          [
            "id",
            "name",
            "description",
            "category",
            "type",
            "currentValue",
            "options",
          ],
          prefix,
        );
        each(record(value)?.options, option, `${prefix}/options`);
      },
      "/update/configOptions",
    );
  return details;
}

function ownerOf(
  s: ThreadState,
  update: Record<string, unknown>,
): ReportedDetailsOwner | undefined {
  const kind = update.sessionUpdate;
  if (kind === "tool_call" || kind === "tool_call_update") {
    const item = s.items.find(
      (item) =>
        item.kind === "tool" &&
        item.call.toolCallId === String(update.toolCallId ?? ""),
    );
    if (item?.kind === "tool") return item.call;
  }
  const tail = streamTailItem(s.items);
  const role =
    kind === "user_message_chunk"
      ? "user"
      : kind === "agent_message_chunk"
        ? "agent"
        : kind === "agent_thought_chunk"
          ? "thought"
          : null;
  if (role && tail?.kind === role) return tail;
  if (kind === "plan" && tail?.kind === "plan") return tail;
  const last: ThreadItem | undefined = s.items.at(-1);
  if (
    last?.kind === "raw" &&
    (last.update === update || last.update === update.content)
  )
    return last;
  if (kind === "compaction_update" || kind === "compaction_summary_chunk")
    return s.items.find(
      (item) =>
        item.kind === "compaction" && item.compactionId === update.compactionId,
    );
  return undefined;
}

/** Call after projection so details attach to the actual reused/new item.
 * Session-level declarations have no transcript item; do not invent one. */
export function retainReportedDetails(
  s: ThreadState,
  update: unknown,
  envelope?: unknown,
  projectedTool?: ToolCallView,
): void {
  const u = record(update);
  // Projection just located this exact view. Reuse it without a second
  // history traversal; standalone/non-tool/raw callers keep the old lookup.
  const projectedOwner =
    projectedTool &&
    (u?.sessionUpdate === "tool_call" ||
      u?.sessionUpdate === "tool_call_update") &&
    projectedTool.toolCallId === String(u.toolCallId ?? "")
      ? projectedTool
      : undefined;
  const owner = projectedOwner ?? (u ? ownerOf(s, u) : undefined);
  const rawAlreadyRetained =
    owner &&
    "kind" in owner &&
    owner.kind === "raw" &&
    "update" in owner &&
    owner.update === update;
  const details = collectReportedDetails(
    rawAlreadyRetained ? undefined : update,
    envelope,
  );
  const kind =
    typeof u?.sessionUpdate === "string" ? u.sessionUpdate : "update";
  const prefix = owner ? "" : path("", kind);
  const target = owner ?? s;
  // These known containers are whole-list replacements, unlike unknown
  // opaque extension values. Removed/reordered entries must not inherit old
  // details solely because they reuse an array position.
  const replace =
    kind === "tool_call" || kind === "tool_call_update"
      ? ["content", "locations"]
      : kind === "plan"
        ? ["entries"]
        : kind === "config_option_update"
          ? ["configOptions"]
          : kind === "available_commands_update"
            ? ["availableCommands"]
            : [];
  const reset = replace
    .filter((key) => Array.isArray(u?.[key]))
    .map((key) => `${prefix}/update/${key}/`);
  const previous = Object.fromEntries(
    Object.entries(target.reportedDetails ?? {}).filter(
      ([key]) => !reset.some((start) => key.startsWith(start)),
    ),
  );
  const scoped = Object.fromEntries(
    Object.entries(details).map(([key, value]) => [prefix + key, value]),
  );
  const combined = { ...previous, ...scoped };
  if (Object.keys(combined).length) target.reportedDetails = combined;
  else delete target.reportedDetails;
}
