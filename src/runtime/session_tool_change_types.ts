import { mcpAddInputError } from "./mcp_add_types";
import type { SessionToolsTarget } from "./session_tools_types";

export const SESSION_TOOL_CHANGE_CODES = [
  "unavailable",
  "changed",
  "busy",
  "timeout",
  "invalidInput",
  "invalidResponse",
  "queryFailed",
  "saveFailed",
  "unknown",
  "limit",
] as const;
export type SessionToolChangeCode = (typeof SESSION_TOOL_CHANGE_CODES)[number];
export type SessionToolChange =
  | { kind: "inspect" }
  | { kind: "addHttp"; name: string; url: string }
  | { kind: "remove"; itemRef: string };
export interface SessionToolChangeRequest extends SessionToolsTarget {
  operationId: string;
}
export interface SessionManagedTool {
  itemRef: string;
  name: string;
  canRemove: boolean;
}
export interface SessionToolChangeOperation {
  kind: SessionToolChange["kind"];
  operationId: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  connectionId: string;
  state: "pending" | "ready" | "failed" | "unknown";
  settled: boolean;
  mutationSent: boolean;
  conversationSaved: boolean;
  persistence: "unreported" | "confirmed" | "unknown";
  activity: "unreported" | "toolsReported" | "absentReported";
  items: SessionManagedTool[];
  error?: { code: SessionToolChangeCode };
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(): never {
  throw { code: "invalidResponse" };
}
function record(value: unknown, required: string[], optional: string[] = []) {
  if (
    !object(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid();
  return value;
}
function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
export function validSessionToolChange(change: SessionToolChange): boolean {
  if (!object(change)) return false;
  if (change.kind === "inspect") return Object.keys(change).length === 1;
  if (change.kind === "addHttp")
    return (
      Object.keys(change).length === 3 && !sessionToolHttpInputError(change)
    );
  return (
    change.kind === "remove" &&
    Object.keys(change).length === 2 &&
    bounded(change.itemRef, 256)
  );
}
export function sessionToolHttpInputError(input: {
  name: string;
  url: string;
}): "invalidName" | "invalidUrl" | null {
  if (
    typeof input.name !== "string" ||
    input.name.length > 128 ||
    input.name.trim() !== input.name ||
    !/[A-Za-z0-9]/.test(input.name) ||
    !/^[A-Za-z0-9 _-]+$/.test(input.name)
  )
    return "invalidName";
  return mcpAddInputError({
    transport: "streamableHttp",
    name: "checked-name",
    url: input.url,
  })
    ? "invalidUrl"
    : null;
}
export function parseSessionManagedTools(raw: unknown): SessionManagedTool[] {
  if (!Array.isArray(raw) || raw.length > 4096) invalid();
  const refs = new Set<string>();
  return raw.map((item) => {
    const value = record(item, ["itemRef", "name", "canRemove"]);
    if (
      !bounded(value.itemRef, 256) ||
      !bounded(value.name, 256) ||
      refs.has(value.itemRef) ||
      typeof value.canRemove !== "boolean"
    )
      invalid();
    refs.add(value.itemRef);
    return {
      itemRef: value.itemRef,
      name: value.name,
      canRemove: value.canRemove,
    };
  });
}
export function sessionToolChangeFailure(
  raw: unknown,
): SessionToolChangeCode | null {
  if (
    !object(raw) ||
    !SESSION_TOOL_CHANGE_CODES.includes(raw.code as SessionToolChangeCode)
  )
    return null;
  return raw.code as SessionToolChangeCode;
}
export function sessionToolChangeRejection(raw: unknown): {
  code: SessionToolChangeCode;
  notDispatched: boolean;
  conversationSaved: boolean;
} | null {
  try {
    const value = record(
      raw,
      ["code", "message"],
      ["notDispatched", "conversationSaved"],
    );
    const code = sessionToolChangeFailure(value);
    if (
      !code ||
      typeof value.message !== "string" ||
      (Object.hasOwn(value, "notDispatched") && value.notDispatched !== true) ||
      (Object.hasOwn(value, "conversationSaved") &&
        value.conversationSaved !== true)
    )
      return null;
    return {
      code,
      notDispatched: value.notDispatched === true,
      conversationSaved: value.conversationSaved === true,
    };
  } catch {
    return null;
  }
}
export function parseSessionToolChangeOperation(
  raw: unknown,
  expected: SessionToolChangeRequest,
  kind: SessionToolChange["kind"],
): SessionToolChangeOperation {
  const v = record(
    raw,
    [
      "operationId",
      "agentId",
      "cwd",
      "nativeSessionId",
      "connectionId",
      "state",
      "settled",
      "mutationSent",
      "conversationSaved",
      "persistence",
      "activity",
      "items",
      "kind",
    ],
    ["error"],
  );
  if (
    v.kind !== kind ||
    v.operationId !== expected.operationId ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.nativeSessionId !== expected.sessionId ||
    v.connectionId !== expected.connectionId ||
    !["pending", "ready", "failed", "unknown"].includes(v.state as string) ||
    typeof v.settled !== "boolean" ||
    typeof v.mutationSent !== "boolean" ||
    typeof v.conversationSaved !== "boolean" ||
    (kind === "inspect" && v.conversationSaved) ||
    (v.mutationSent && !v.conversationSaved) ||
    (v.state === "pending" && v.settled) ||
    (v.state === "ready" && !v.settled) ||
    !["unreported", "confirmed", "unknown"].includes(v.persistence as string) ||
    !["unreported", "toolsReported", "absentReported"].includes(
      v.activity as string,
    )
  )
    invalid();
  let error: SessionToolChangeOperation["error"];
  if (Object.hasOwn(v, "error")) {
    const failure = sessionToolChangeRejection(v.error);
    if (!failure) invalid();
    error = { code: failure.code };
  }
  return {
    operationId: expected.operationId,
    kind,
    agentId: expected.agentId,
    cwd: expected.cwd,
    nativeSessionId: expected.sessionId,
    connectionId: expected.connectionId,
    state: v.state as SessionToolChangeOperation["state"],
    settled: v.settled,
    mutationSent: v.mutationSent,
    conversationSaved: v.conversationSaved,
    persistence: v.persistence as SessionToolChangeOperation["persistence"],
    activity: v.activity as SessionToolChangeOperation["activity"],
    items: parseSessionManagedTools(v.items),
    ...(error ? { error } : {}),
  };
}
