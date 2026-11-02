import type { ThreadState, ToolCallView } from "./session_types";

/** Field names supplied by the connection layer, never copied input bodies. */
export interface FileInputFields {
  operation: "edit" | "write";
  path: string;
  oldText?: string;
  newText: string;
}

function fields(value: unknown): value is FileInputFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  return (
    (f.operation === "edit" || f.operation === "write") &&
    typeof f.path === "string" &&
    f.path.length > 0 &&
    typeof f.newText === "string" &&
    f.newText.length > 0 &&
    (f.operation !== "edit" ||
      (typeof f.oldText === "string" && f.oldText.length > 0))
  );
}

export function fileInputDiff(call: ToolCallView): {
  path: string;
  oldText: string | null;
  newText: string;
  source: "edit-input" | "write-input";
} | null {
  if (call.kind !== "other" && call.kind !== "edit") return null;
  const f = call.fileInputFields;
  const input = call.rawInput;
  if (!fields(f) || !input || typeof input !== "object" || Array.isArray(input))
    return null;
  const value = (key: string) =>
    Object.hasOwn(input, key)
      ? (input as Record<string, unknown>)[key]
      : undefined;
  const path = value(f.path);
  const newText = value(f.newText);
  const oldText = f.operation === "edit" ? value(f.oldText!) : null;
  if (
    typeof path !== "string" ||
    !path ||
    typeof newText !== "string" ||
    (f.operation === "edit" && typeof oldText !== "string")
  )
    return null;
  return {
    path,
    oldText: oldText as string | null,
    newText,
    source: f.operation === "edit" ? "edit-input" : "write-input",
  };
}

/** A passive, per-tool presentation hint; official kind/status/input stay intact. */
export function receiveFileInput(
  s: ThreadState,
  event: Record<string, unknown>,
): void {
  if (event.source !== "reported" || typeof event.toolCallId !== "string")
    return;
  const matches = s.items.filter(
    (i) => i.kind === "tool" && i.call.toolCallId === event.toolCallId,
  );
  if (matches.length !== 1 || matches[0].kind !== "tool") return;
  const call = matches[0].call;
  if (event.fields === null) {
    delete call.fileInputFields;
    return;
  }
  if (!fields(event.fields)) return;
  const candidate = { ...call, fileInputFields: event.fields };
  if (fileInputDiff(candidate)) call.fileInputFields = { ...event.fields };
}

export function presentedToolKind(call: ToolCallView): string {
  return fileInputDiff(call) ? "edit" : call.kind;
}
