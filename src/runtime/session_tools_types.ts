/** Current-connection read support reported by acp_client, not Agent initialize. */
export interface SessionToolInventoryCapability {
  source: "reviewedOfficialSupplement";
  scope: "currentConversation";
  startup?: SessionToolStartupReport;
}
export interface SessionToolStartupReport {
  reportedCount: number;
  loadedCount: number;
  failedCount: number;
  unknownCount: number;
}
export const SESSION_TOOLS_CODES = [
  "unavailable",
  "changed",
  "busy",
  "timeout",
  "invalidResponse",
  "queryFailed",
] as const;
export type SessionToolsCode = (typeof SESSION_TOOLS_CODES)[number];
/** Public display uses the local code mapping; remote error prose is never retained. */
export interface SessionToolsFailure {
  code: SessionToolsCode;
}
export interface SessionToolsTarget {
  agentId: string;
  cwd: string;
  sessionId: string;
  connectionId: string;
}
export interface SessionToolsRequest extends SessionToolsTarget {
  operationId: string;
}
export interface SessionToolItem {
  name: string;
  description: string | null;
  permission: "always_allow" | "ask_before" | "never_allow" | null;
  nameTruncated: boolean;
  descriptionTruncated: boolean;
}
export interface SessionToolsReport {
  observedAtMs: number;
  completeness: "unreported";
  reportedItemCount: number;
  itemsTruncated: boolean;
  items: SessionToolItem[];
}
export interface SessionToolsOperation {
  operationId: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  connectionId: string;
  state: "pending" | "ready" | "failed";
  settled: boolean;
  report: SessionToolsReport | null;
  error: SessionToolsFailure | null;
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const MAX_REPORT_ITEMS = 256;
function invalid(): never {
  throw { code: "invalidResponse" };
}
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
  return value;
}
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : invalid());
function integer(v: unknown): number {
  return Number.isSafeInteger(v) && (v as number) >= 0
    ? (v as number)
    : invalid();
}
function text(v: unknown, max: number, multiline = false): string {
  if (
    typeof v !== "string" ||
    Array.from(v).length > max ||
    (multiline
      ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
      : /[\u0000-\u001f\u007f-\u009f]/
    ).test(v)
  )
    invalid();
  return v;
}
export function validSessionToolsOperationId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
}
export function sessionToolInventoryCapability(
  value: unknown,
): SessionToolInventoryCapability | null {
  if (
    !object(value) ||
    !Object.hasOwn(value, "source") ||
    !Object.hasOwn(value, "scope") ||
    value.source !== "reviewedOfficialSupplement" ||
    value.scope !== "currentConversation"
  )
    return null;
  const hasStartup = Object.hasOwn(value, "startup");
  if (Object.keys(value).length !== (hasStartup ? 3 : 2)) return null;
  const capability: SessionToolInventoryCapability = {
    source: "reviewedOfficialSupplement",
    scope: "currentConversation",
  };
  if (!hasStartup) return capability;
  try {
    const startup = record(value.startup, [
      "reportedCount",
      "loadedCount",
      "failedCount",
      "unknownCount",
    ]);
    const reportedCount = integer(startup.reportedCount);
    const loadedCount = integer(startup.loadedCount);
    const failedCount = integer(startup.failedCount);
    const unknownCount = integer(startup.unknownCount);
    if (
      loadedCount + failedCount + unknownCount !==
      Math.min(reportedCount, MAX_REPORT_ITEMS)
    )
      return null;
    return {
      ...capability,
      startup: { reportedCount, loadedCount, failedCount, unknownCount },
    };
  } catch {
    return null;
  }
}
export function sessionToolsFailure(
  value: unknown,
): SessionToolsFailure | null {
  try {
    const v = record(value, ["code", "message"]);
    if (!SESSION_TOOLS_CODES.includes(v.code as SessionToolsCode)) invalid();
    text(v.message, 2048, true);
    return { code: v.code as SessionToolsCode };
  } catch {
    return null;
  }
}
function item(value: unknown): SessionToolItem {
  const v = record(value, [
    "name",
    "description",
    "permission",
    "nameTruncated",
    "descriptionTruncated",
  ]);
  const name = text(v.name, 256),
    description =
      v.description === null ? null : text(v.description, 2048, true),
    nameTruncated = bool(v.nameTruncated),
    descriptionTruncated = bool(v.descriptionTruncated);
  if (
    !name ||
    (description === null && descriptionTruncated) ||
    (v.permission !== null &&
      !["always_allow", "ask_before", "never_allow"].includes(
        v.permission as string,
      ))
  )
    invalid();
  return {
    name,
    description,
    permission: v.permission as SessionToolItem["permission"],
    nameTruncated,
    descriptionTruncated,
  };
}
function report(value: unknown): SessionToolsReport {
  const v = record(value, [
    "observedAtMs",
    "completeness",
    "reportedItemCount",
    "itemsTruncated",
    "items",
  ]);
  const reportedItemCount = integer(v.reportedItemCount),
    itemsTruncated = bool(v.itemsTruncated);
  if (
    v.completeness !== "unreported" ||
    !Array.isArray(v.items) ||
    v.items.length !== Math.min(reportedItemCount, MAX_REPORT_ITEMS) ||
    itemsTruncated !== reportedItemCount > MAX_REPORT_ITEMS
  )
    invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    completeness: "unreported",
    reportedItemCount,
    itemsTruncated,
    items: v.items.map(item),
  };
}
export function parseSessionToolsOperation(
  value: unknown,
  expected: SessionToolsRequest,
): SessionToolsOperation {
  const v = record(value, [
    "operationId",
    "agentId",
    "cwd",
    "nativeSessionId",
    "connectionId",
    "state",
    "settled",
    "report",
    "error",
  ]);
  if (
    !validSessionToolsOperationId(expected.operationId) ||
    ![
      expected.agentId,
      expected.cwd,
      expected.sessionId,
      expected.connectionId,
    ].every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 8192 &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    ) ||
    v.operationId !== expected.operationId ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.nativeSessionId !== expected.sessionId ||
    v.connectionId !== expected.connectionId
  )
    invalid();
  const settled = bool(v.settled),
    parsedReport = v.report === null ? null : report(v.report),
    error = v.error === null ? null : sessionToolsFailure(v.error);
  if (v.error !== null && error === null) invalid();
  if (
    v.state === "pending"
      ? settled || parsedReport !== null || error !== null
      : v.state === "ready"
        ? !settled || parsedReport === null || error !== null
        : v.state === "failed"
          ? parsedReport !== null || error === null
          : true
  )
    invalid();
  return {
    operationId: expected.operationId,
    agentId: expected.agentId,
    cwd: expected.cwd,
    nativeSessionId: expected.sessionId,
    connectionId: expected.connectionId,
    state: v.state as SessionToolsOperation["state"],
    settled,
    report: parsedReport,
    error,
  };
}
