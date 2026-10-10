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
export type InventoryKind = "mcp" | "skills";
export interface InventoryCapability {
  availability: "available" | "unavailable";
  source: "officialCli" | "officialAppServer" | null;
  reason: ExtensionCode | null;
}
export interface ExtensionCapabilities {
  selectionId: string | null;
  mcpInventory: InventoryCapability;
  skillsInventory: InventoryCapability;
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
export interface SkillInventoryItem {
  id: number;
  name: string | null;
  description: string | null;
  descriptionTruncated: boolean;
  descriptionRedacted: boolean;
  reportedEnabled: boolean;
  origin: "user" | "repo" | "system" | "admin" | "unknown";
  pluginReported: boolean;
}
export interface SkillsInventory {
  observedAtMs: number;
  scope: "officialSkillsForDirectory";
  source: "officialAppServer";
  complete: boolean;
  sessionApplicability: "unverified";
  errorCount: number;
  items: SkillInventoryItem[];
}
export type InventorySnapshot = McpInventory | SkillsInventory;
export interface InventoryRequest {
  kind: InventoryKind;
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
  snapshot?: InventorySnapshot;
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
  const capability = (
    raw: unknown,
    source: "officialCli" | "officialAppServer",
  ): InventoryCapability => {
    const m = object(raw, ["availability", "source", "reason"]);
    const availability = one(m.availability, ["available", "unavailable"]);
    if (availability === "available") {
      if (m.source !== source || m.reason !== null) return invalid();
      return { availability, source, reason: null };
    }
    if (
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
      availability,
      source: null,
      reason: one(m.reason, EXTENSION_CODES),
    };
  };
  const mcpInventory = capability(v.mcpInventory, "officialCli");
  const skillsInventory = capability(v.skillsInventory, "officialAppServer");
  const available =
    mcpInventory.availability === "available" ||
    skillsInventory.availability === "available";
  if (
    v.toolInventory !== "unavailable" ||
    (available ? !validInventoryId(v.selectionId) : v.selectionId !== null)
  )
    return invalid();
  return {
    selectionId: v.selectionId as string | null,
    mcpInventory,
    skillsInventory,
    toolInventory: "unavailable",
  };
}
function skillsLabel(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value ||
    new TextEncoder().encode(value).length > 256 ||
    value.includes("..") ||
    (!/^[\p{Alphabetic}\p{Number} ._-]+$/u.test(value) &&
      !/^[\p{Alphabetic}\p{Number}._-]+:[\p{Alphabetic}\p{Number}._-]+$/u.test(
        value,
      ))
  )
    return invalid();
  return value;
}
function skillsSnapshot(value: unknown): SkillsInventory {
  const v = object(value, [
    "observedAtMs",
    "scope",
    "source",
    "complete",
    "sessionApplicability",
    "errorCount",
    "items",
  ]);
  if (
    !Number.isSafeInteger(v.observedAtMs) ||
    (v.observedAtMs as number) < 0 ||
    v.scope !== "officialSkillsForDirectory" ||
    v.source !== "officialAppServer" ||
    v.sessionApplicability !== "unverified" ||
    !Number.isInteger(v.errorCount) ||
    (v.errorCount as number) < 0 ||
    (v.errorCount as number) > 512 ||
    v.complete !== (v.errorCount === 0) ||
    !Array.isArray(v.items) ||
    v.items.length > 512
  )
    return invalid();
  const items = v.items.map((raw, index): SkillInventoryItem => {
    const i = object(raw, [
      "id",
      "name",
      "description",
      "descriptionTruncated",
      "descriptionRedacted",
      "reportedEnabled",
      "origin",
      "pluginReported",
    ]);
    if (
      i.id !== index ||
      [
        i.descriptionTruncated,
        i.descriptionRedacted,
        i.reportedEnabled,
        i.pluginReported,
      ].some((x) => typeof x !== "boolean")
    )
      return invalid();
    if (
      i.description !== null &&
      (typeof i.description !== "string" ||
        !i.description.trim() ||
        [...i.description].length > 2048 ||
        new TextEncoder().encode(i.description).length > 8192)
    )
      return invalid();
    return {
      id: index,
      name: skillsLabel(i.name),
      description: i.description as string | null,
      descriptionTruncated: i.descriptionTruncated as boolean,
      descriptionRedacted: i.descriptionRedacted as boolean,
      reportedEnabled: i.reportedEnabled as boolean,
      origin: one(i.origin, ["user", "repo", "system", "admin", "unknown"]),
      pluginReported: i.pluginReported as boolean,
    };
  });
  return {
    observedAtMs: v.observedAtMs as number,
    scope: "officialSkillsForDirectory",
    source: "officialAppServer",
    complete: v.complete as boolean,
    sessionApplicability: "unverified",
    errorCount: v.errorCount as number,
    items,
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
    ["requestId", "agentId", "cwd", "kind", "state", "settled"],
    ["code", "snapshot"],
  );
  if (
    v.requestId !== expected.requestId ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.kind !== expected.kind ||
    !["mcp", "skills"].includes(String(v.kind)) ||
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
    ...(state === "ready"
      ? {
          snapshot:
            expected.kind === "skills"
              ? skillsSnapshot(v.snapshot)
              : snapshot(v.snapshot),
        }
      : {}),
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
