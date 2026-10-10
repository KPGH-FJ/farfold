export const EXTENSION_CODES = [
  "notReviewed",
  "entryUnverified",
  "platformUnsupported",
  "environmentUnavailable",
  "selectionChanged",
  "cwdUnavailable",
  "busy",
  "spawnFailed",
  "queryFailed",
  "invalidOutput",
  "outputLimit",
  "timedOut",
  "cancelled",
  "pendingCleanup",
  "unknownRequest",
  "invalidRequest",
  "requestConflict",
  "unavailable",
] as const;
export type ExtensionCode = (typeof EXTENSION_CODES)[number];
export interface ExtensionCapabilities {
  selectionId: string | null;
  mcpInventory: {
    availability: "available" | "unavailable";
    source: "officialCli" | null;
    reason: ExtensionCode | null;
  };
  skillsInventory: "unavailable";
  toolInventory: "unavailable";
}
export interface InventoryItem {
  id: number;
  name: string | null;
  transport: "stdio" | "streamableHttp" | "unknown";
  reportedEnabled: boolean;
  reportedAuth:
    "oauth" | "bearerToken" | "notLoggedIn" | "unsupported" | "unknown";
  origin: "unreported";
  configurationLayer: "unreported";
  connection: "unverified";
  tools: "unreported";
}
export interface McpInventory {
  observedAtMs: number;
  scope: "officialCliConfigurationForDirectory";
  source: "officialCli";
  complete: true;
  sessionApplicability: "unverified";
  items: InventoryItem[];
}
export interface InventoryRequest {
  agentId: string;
  requestId: string;
  cwd: string;
}
export interface InventoryOperation extends InventoryRequest {
  state:
    | "running"
    | "cancelling"
    | "pendingCleanup"
    | "ready"
    | "failed"
    | "cancelled";
  settled: boolean;
  code?: ExtensionCode;
  snapshot?: McpInventory;
}
function invalid(): never {
  throw { code: "invalidOutput" };
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const v = value as Record<string, unknown>;
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    return invalid();
  return v;
}
function one<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : invalid();
}
export function extensionFailure(value: unknown): ExtensionCode | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" &&
    EXTENSION_CODES.includes(code as ExtensionCode)
    ? (code as ExtensionCode)
    : null;
}
export function validInventoryDirectory(value: string): boolean {
  return (
    /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value) &&
    new TextEncoder().encode(value).length <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
export function validInventoryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
      value,
    )
  );
}
export function parseExtensionCapabilities(
  value: unknown,
): ExtensionCapabilities {
  const v = object(value, [
    "selectionId",
    "mcpInventory",
    "skillsInventory",
    "toolInventory",
  ]);
  const m = object(v.mcpInventory, ["availability", "source", "reason"]);
  const availability = one(m.availability, ["available", "unavailable"]);
  if (v.skillsInventory !== "unavailable" || v.toolInventory !== "unavailable")
    return invalid();
  if (availability === "available") {
    if (
      !validInventoryId(v.selectionId) ||
      m.source !== "officialCli" ||
      m.reason !== null
    )
      return invalid();
  } else if (
    v.selectionId !== null ||
    m.source !== null ||
    ![
      "notReviewed",
      "entryUnverified",
      "platformUnsupported",
      "environmentUnavailable",
    ].includes(String(m.reason))
  )
    return invalid();
  return {
    selectionId: v.selectionId as string | null,
    mcpInventory: {
      availability,
      source: availability === "available" ? "officialCli" : null,
      reason:
        availability === "available" ? null : one(m.reason, EXTENSION_CODES),
    },
    skillsInventory: "unavailable",
    toolInventory: "unavailable",
  };
}
function snapshot(value: unknown): McpInventory {
  const v = object(value, [
    "observedAtMs",
    "scope",
    "source",
    "complete",
    "sessionApplicability",
    "items",
  ]);
  if (
    !Number.isSafeInteger(v.observedAtMs) ||
    (v.observedAtMs as number) < 0 ||
    v.scope !== "officialCliConfigurationForDirectory" ||
    v.source !== "officialCli" ||
    v.complete !== true ||
    v.sessionApplicability !== "unverified" ||
    !Array.isArray(v.items) ||
    v.items.length > 512
  )
    return invalid();
  const items = v.items.map((raw, index): InventoryItem => {
    const i = object(raw, [
      "id",
      "name",
      "transport",
      "reportedEnabled",
      "reportedAuth",
      "origin",
      "configurationLayer",
      "connection",
      "tools",
    ]);
    if (
      i.id !== index ||
      typeof i.reportedEnabled !== "boolean" ||
      i.origin !== "unreported" ||
      i.configurationLayer !== "unreported" ||
      i.connection !== "unverified" ||
      i.tools !== "unreported"
    )
      return invalid();
    if (
      i.name !== null &&
      (typeof i.name !== "string" ||
        !i.name ||
        new TextEncoder().encode(i.name).length > 256 ||
        i.name.includes("..") ||
        !/^[\p{Alphabetic}\p{Number} ._-]+$/u.test(i.name))
    )
      return invalid();
    return {
      id: index,
      name: i.name as string | null,
      transport: one(i.transport, ["stdio", "streamableHttp", "unknown"]),
      reportedEnabled: i.reportedEnabled,
      reportedAuth: one(i.reportedAuth, [
        "oauth",
        "bearerToken",
        "notLoggedIn",
        "unsupported",
        "unknown",
      ]),
      origin: "unreported",
      configurationLayer: "unreported",
      connection: "unverified",
      tools: "unreported",
    };
  });
  return {
    observedAtMs: v.observedAtMs as number,
    scope: "officialCliConfigurationForDirectory",
    source: "officialCli",
    complete: true,
    sessionApplicability: "unverified",
    items,
  };
}
export function parseInventoryOperation(
  value: unknown,
  expected: InventoryRequest,
): InventoryOperation {
  const v = object(
    value,
    ["requestId", "agentId", "cwd", "state", "settled"],
    ["code", "snapshot"],
  );
  if (
    v.requestId !== expected.requestId ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    typeof v.settled !== "boolean"
  )
    return invalid();
  const state = one(v.state, [
    "running",
    "cancelling",
    "pendingCleanup",
    "ready",
    "failed",
    "cancelled",
  ]);
  const terminal = ["ready", "failed", "cancelled"].includes(state);
  if (
    terminal !== v.settled ||
    (state === "ready") !== Object.hasOwn(v, "snapshot") ||
    (state === "ready" && Object.hasOwn(v, "code"))
  )
    return invalid();
  const code = Object.hasOwn(v, "code")
    ? one(v.code, EXTENSION_CODES)
    : undefined;
  if ((state === "failed" || state === "cancelled") && !code) return invalid();
  return {
    ...expected,
    state,
    settled: terminal,
    ...(code ? { code } : {}),
    ...(state === "ready" ? { snapshot: snapshot(v.snapshot) } : {}),
  };
}
export function parseInventoryCancellation(
  value: unknown,
  expected: InventoryRequest,
): InventoryOperation | null {
  const v = object(value, [
    "requestId",
    "agentId",
    "cancelRequested",
    "operation",
  ]);
  if (
    v.requestId !== expected.requestId ||
    v.agentId !== expected.agentId ||
    v.cancelRequested !== true
  )
    return invalid();
  return v.operation === null
    ? null
    : parseInventoryOperation(v.operation, expected);
}
