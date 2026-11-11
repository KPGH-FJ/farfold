/** Current-connection read support reported by acp_client, not Agent initialize. */
export interface SessionToolInventoryCapability {
  source: "reviewedOfficialSupplement";
  scope: "currentConversation";
  startup?: SessionToolStartupReport;
  extensions?: string[];
  configuration?: true;
  toolsUnavailable?: true;
  management?: true;
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
  "readLimit",
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
  extensionName?: string;
  configuration?: true;
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
const CONFIGURATION_KINDS = [
  "builtin",
  "platform",
  "http",
  "local",
  "other",
] as const;
export interface SessionToolConfigurationReport {
  observedAtMs: number;
  source: "unreported";
  connectionStatus: "unreported";
  reportedItemCount: number;
  itemsTruncated: boolean;
  items: { name: string | null; kind: (typeof CONFIGURATION_KINDS)[number] }[];
}
export interface SessionToolsOperation {
  operationId: string;
  agentId: string;
  cwd: string;
  nativeSessionId: string;
  connectionId: string;
  extensionName?: string;
  configuration?: true;
  state: "pending" | "ready" | "failed";
  settled: boolean;
  report: SessionToolsReport | null;
  configurationReport?: SessionToolConfigurationReport;
  error: SessionToolsFailure | null;
}

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const MAX_REPORT_ITEMS = 256;
const isExtensionName = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 256 &&
  v.trim() === v &&
  /[A-Za-z0-9]/.test(v) &&
  /^[A-Za-z0-9 _-]+$/.test(v);
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
  const hasExtensions = Object.hasOwn(value, "extensions");
  const hasConfiguration = Object.hasOwn(value, "configuration");
  const toolsUnavailable = Object.hasOwn(value, "toolsUnavailable");
  const management = Object.hasOwn(value, "management");
  if (
    Object.keys(value).length !==
    2 +
      Number(hasStartup) +
      Number(hasExtensions) +
      Number(hasConfiguration) +
      Number(toolsUnavailable) +
      Number(management)
  )
    return null;
  const capability: SessionToolInventoryCapability = {
    source: "reviewedOfficialSupplement",
    scope: "currentConversation",
  };
  if (management) {
    if (value.management !== true) return null;
    capability.management = true;
  }
  if (hasConfiguration) {
    if (value.configuration !== true) return null;
    capability.configuration = true;
  }
  if (toolsUnavailable) {
    if (
      value.toolsUnavailable !== true ||
      !capability.configuration ||
      hasExtensions
    )
      return null;
    capability.toolsUnavailable = true;
  }
  if (hasExtensions) {
    const names = value.extensions;
    if (
      !hasStartup ||
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > MAX_REPORT_ITEMS ||
      !names.every(isExtensionName) ||
      new Set(names).size !== names.length
    )
      return null;
    capability.extensions = names;
  }
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
        Math.min(reportedCount, MAX_REPORT_ITEMS) ||
      (capability.extensions?.length ?? 0) > loadedCount
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
function configurationReport(value: unknown): SessionToolConfigurationReport {
  const v = record(value, [
    "observedAtMs",
    "source",
    "connectionStatus",
    "reportedItemCount",
    "itemsTruncated",
    "items",
  ]);
  const count = integer(v.reportedItemCount),
    truncated = bool(v.itemsTruncated);
  if (
    v.source !== "unreported" ||
    v.connectionStatus !== "unreported" ||
    !Array.isArray(v.items) ||
    v.items.length !== Math.min(count, MAX_REPORT_ITEMS) ||
    truncated !== count > MAX_REPORT_ITEMS
  )
    invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    source: "unreported",
    connectionStatus: "unreported",
    reportedItemCount: count,
    itemsTruncated: truncated,
    items: v.items.map((item) => {
      const { name, kind } = record(item, ["name", "kind"]);
      if (
        (name !== null && !isExtensionName(name)) ||
        !CONFIGURATION_KINDS.includes(
          kind as (typeof CONFIGURATION_KINDS)[number],
        )
      )
        invalid();
      return { name, kind: kind as (typeof CONFIGURATION_KINDS)[number] };
    }),
  };
}
export function parseSessionToolsOperation(
  value: unknown,
  expected: SessionToolsRequest,
): SessionToolsOperation {
  const configuration = expected.configuration === true;
  const hasConfigurationReport =
    object(value) && Object.hasOwn(value, "configurationReport");
  const v = record(value, [
    "operationId",
    "agentId",
    "cwd",
    "nativeSessionId",
    "connectionId",
    ...(expected.extensionName === undefined ? [] : ["extensionName"]),
    ...(configuration ? ["configuration"] : []),
    ...(configuration && hasConfigurationReport ? ["configurationReport"] : []),
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
    v.connectionId !== expected.connectionId ||
    (configuration &&
      (expected.extensionName !== undefined ||
        v.configuration !== true ||
        v.report !== null)) ||
    (expected.extensionName !== undefined &&
      (!isExtensionName(expected.extensionName) ||
        v.extensionName !== expected.extensionName))
  )
    invalid();
  const settled = bool(v.settled),
    parsedReport = v.report === null ? null : report(v.report),
    parsedConfiguration = hasConfigurationReport
      ? configurationReport(v.configurationReport)
      : undefined,
    error = v.error === null ? null : sessionToolsFailure(v.error);
  const hasReport = parsedReport !== null || parsedConfiguration !== undefined;
  if (v.error !== null && error === null) invalid();
  if (
    v.state === "pending"
      ? settled || hasReport || error !== null
      : v.state === "ready"
        ? !settled || !hasReport || error !== null
        : v.state === "failed"
          ? hasReport || error === null
          : true
  )
    invalid();
  return {
    operationId: expected.operationId,
    agentId: expected.agentId,
    cwd: expected.cwd,
    nativeSessionId: expected.sessionId,
    connectionId: expected.connectionId,
    ...(expected.extensionName === undefined
      ? {}
      : { extensionName: expected.extensionName }),
    ...(configuration ? { configuration: true } : {}),
    ...(parsedConfiguration
      ? { configurationReport: parsedConfiguration }
      : {}),
    state: v.state as SessionToolsOperation["state"],
    settled,
    report: parsedReport,
    error,
  };
}
