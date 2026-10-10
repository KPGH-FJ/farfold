import { validMcpHttpUrl } from "./mcp_http_url";
import { SKILL_CHANGE_CODES } from "./skill_management_types";
import type {
  SkillChangeConfirmInput,
  SkillChangeRequestKey,
  SkillChangeRecheckInput,
} from "./skill_management_types";
import { validInventoryId } from "./extension_inventory_types";
import {
  invalid,
  record,
  one,
  integer,
  text,
  bool,
  OPERATION_KEYS,
  operationIdentity,
  lifecycle,
  cancelledOperation,
} from "./extension_change_validation";
// MCP preference DTO: safe metadata only; no public write authority.
export type McpAddAction = "inspect" | "add" | "recheck";
export type McpAddTarget = {
  kind: "mcpAddition";
  inventoryRequestId: string;
  inputId: string;
  name: string;
  transport: "stdio" | "streamableHttp";
};
export type McpAddReview = {
  reviewId: string;
  agentId: string;
  cwd: string;
  target: McpAddTarget;
  requestedEnabled: false;
  configuredEnabled: null;
  reportedEnabled: null;
  writeScope: { kind: "user" | "profile"; configDisplayPath: string };
  observedAtMs: number;
  validForMs: 300000;
  mutation: "addDisabledStdioMcp" | "addDisabledHttpMcp";
  nameAvailability: "absentInCheckedScopes";
  preservation: "otherConfigurationSemanticsPreserved";
  sessionApplicability: "unverified";
};
export type McpAddObservation = {
  observedAtMs: number;
  configuration: "matching" | "different";
  mcp: "matching" | "different" | "missing";
  configuredEnabled: boolean | null;
  reportedEnabled: boolean | null;
  sessionApplicability: "unverified";
};
export type McpAddOperation = {
  agentId: string;
  requestId: string;
  action: McpAddAction;
  cwd: string;
  target: McpAddTarget;
  requestedEnabled: false;
  operationId: string | null;
  state:
    | "running"
    | "cancelling"
    | "pendingCleanup"
    | "ready"
    | "failed"
    | "cancelled";
  phase:
    | "queued"
    | "starting"
    | "reading"
    | "writing"
    | "checking"
    | "cleaning"
    | "complete";
  settled: boolean;
  writeDispatched: boolean;
  writeAck: "none" | "ok" | "okOverridden" | "rejected" | "unknown";
  outcome:
    | "notDispatched"
    | "rejected"
    | "verified"
    | "observed"
    | "mismatch"
    | "unknown"
    | null;
  code: McpAddCode | null;
  review: McpAddReview | null;
  observation: McpAddObservation | null;
};
export const MCP_ADD_CODES = [
  ...SKILL_CHANGE_CODES,
  "nameConflict",
  "invalidName",
  "invalidExecutablePath",
  "invalidArguments",
  "invalidUrl",
] as const;
export type McpAddCode = (typeof MCP_ADD_CODES)[number];
export type McpStdioInput = Readonly<{
  name: string;
  executablePath: string;
  args: readonly string[];
}>;
export type McpHttpInput = Readonly<{
  transport: "streamableHttp";
  name: string;
  url: string;
}>;
export type McpAddInput = McpStdioInput | McpHttpInput;
export function isHttpInput(value: McpAddInput): value is McpHttpInput {
  return "transport" in value;
}
export type McpAddInspectInput = {
  agentId: string;
  requestId: string;
  inventoryRequestId: string;
  inputId: string;
  input: McpAddInput;
};
const bytes = (s: string) => new TextEncoder().encode(s).length;
// Fixed input-control set shared with the backend, not a general
// invisible-glyph or credential detector. No runtime Unicode dependency.
const prohibitedRanges = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x600, 0x605],
  [0x61c, 0x61c],
  [0x6dd, 0x6dd],
  [0x70f, 0x70f],
  [0x890, 0x891],
  [0x8e2, 0x8e2],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xd800, 0xdfff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
] as const;
function hidden(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (
      prohibitedRanges.some(([first, last]) => point >= first && point <= last)
    )
      return true;
  }
  return false;
}
export function mcpAddInputError(value: unknown): McpAddCode | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "invalidRequest";
  const v = value as Record<string, unknown>;
  const http = v.transport === "streamableHttp";
  if (
    Object.keys(v).length !== 3 ||
    !(
      http ? ["transport", "name", "url"] : ["name", "executablePath", "args"]
    ).every((k) => Object.hasOwn(v, k))
  )
    return "invalidRequest";
  if (
    typeof v.name !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(v.name) ||
    v.name.includes("..") ||
    bytes(v.name) > 256 ||
    v.name === "codex_apps"
  )
    return "invalidName";
  if (http)
    return validMcpHttpUrl(v.url, hidden) && bytes(JSON.stringify(v)) <= 32768
      ? null
      : "invalidUrl";
  if (
    typeof v.executablePath !== "string" ||
    !v.executablePath.startsWith("/") ||
    bytes(v.executablePath) > 4096 ||
    hidden(v.executablePath) ||
    v.executablePath
      .slice(1)
      .split("/")
      .some((p) => !p || p === "." || p === "..")
  )
    return "invalidExecutablePath";
  if (
    !Array.isArray(v.args) ||
    v.args.length > 64 ||
    Array.from(v.args).some(
      (a) => typeof a !== "string" || bytes(a) > 1024 || hidden(a),
    )
  )
    return "invalidArguments";
  if (
    (v.args as string[]).reduce((n, a) => n + bytes(a), 0) > 16384 ||
    bytes(JSON.stringify(v)) > 32768
  )
    return "invalidArguments";
  return null;
}
export function freezeMcpAddInput<T extends McpAddInput>(value: T): T {
  const error = mcpAddInputError(value);
  if (error) throw { code: error };
  return (
    isHttpInput(value)
      ? Object.freeze({
          transport: "streamableHttp",
          name: value.name,
          url: value.url,
        })
      : Object.freeze({
          name: value.name,
          executablePath: value.executablePath,
          args: Object.freeze([...value.args]),
        })
  ) as T;
}
export function mcpAddFailure(value: unknown): McpAddCode | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && MCP_ADD_CODES.includes(code as McpAddCode)
    ? (code as McpAddCode)
    : null;
}
export type McpAddConfirmInput = SkillChangeConfirmInput;
export type McpAddRequestKey = SkillChangeRequestKey;
export type McpAddRecheckInput = SkillChangeRecheckInput;
export type McpAddRequest = Pick<
  McpAddOperation,
  | "agentId"
  | "requestId"
  | "action"
  | "cwd"
  | "target"
  | "requestedEnabled"
  | "operationId"
>;
function target(raw: unknown, expected: McpAddRequest): McpAddTarget {
  const v = record(raw, [
    "kind",
    "inventoryRequestId",
    "inputId",
    "name",
    "transport",
  ]);
  if (
    v.kind !== "mcpAddition" ||
    !validInventoryId(v.inventoryRequestId) ||
    v.inventoryRequestId !== expected.target.inventoryRequestId ||
    !validInventoryId(v.inputId) ||
    v.inputId !== expected.target.inputId ||
    v.name !== expected.target.name ||
    v.transport !== expected.target.transport
  )
    invalid();
  const name = text(v.name, 256);
  if (
    name.includes("..") ||
    name === "codex_apps" ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  )
    invalid();
  return {
    kind: "mcpAddition",
    inventoryRequestId: v.inventoryRequestId as string,
    inputId: v.inputId as string,
    name,
    transport: one(v.transport, ["stdio", "streamableHttp"]),
  };
}
function review(raw: unknown, expected: McpAddRequest): McpAddReview {
  const v = record(raw, [
    "reviewId",
    "agentId",
    "cwd",
    "target",
    "requestedEnabled",
    "configuredEnabled",
    "reportedEnabled",
    "writeScope",
    "observedAtMs",
    "validForMs",
    "mutation",
    "nameAvailability",
    "preservation",
    "sessionApplicability",
  ]);
  if (
    !validInventoryId(v.reviewId) ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.requestedEnabled !== expected.requestedEnabled ||
    v.validForMs !== 300000 ||
    v.configuredEnabled !== null ||
    v.reportedEnabled !== null ||
    v.nameAvailability !== "absentInCheckedScopes" ||
    v.mutation !==
      (expected.target.transport === "streamableHttp"
        ? "addDisabledHttpMcp"
        : "addDisabledStdioMcp") ||
    v.preservation !== "otherConfigurationSemanticsPreserved" ||
    v.sessionApplicability !== "unverified"
  )
    invalid();
  const scope = record(v.writeScope, ["kind", "configDisplayPath"]);
  return {
    reviewId: v.reviewId as string,
    agentId: expected.agentId,
    cwd: expected.cwd,
    target: target(v.target, expected),
    requestedEnabled: expected.requestedEnabled,
    configuredEnabled: null,
    reportedEnabled: null,
    writeScope: {
      kind: one(scope.kind, ["user", "profile"]),
      configDisplayPath: text(scope.configDisplayPath),
    },
    observedAtMs: integer(v.observedAtMs),
    validForMs: 300000,
    mutation:
      expected.target.transport === "streamableHttp"
        ? "addDisabledHttpMcp"
        : "addDisabledStdioMcp",
    nameAvailability: "absentInCheckedScopes",
    preservation: "otherConfigurationSemanticsPreserved",
    sessionApplicability: "unverified",
  };
}
function observation(raw: unknown, expected: McpAddRequest): McpAddObservation {
  const v = record(raw, [
    "observedAtMs",
    "configuration",
    "mcp",
    "configuredEnabled",
    "reportedEnabled",
    "sessionApplicability",
  ]);
  if (v.sessionApplicability !== "unverified") invalid();
  const configuration = one(v.configuration, ["matching", "different"]),
    mcp = one(v.mcp, ["matching", "different", "missing"]);
  const configuredEnabled =
      v.configuredEnabled === null ? null : bool(v.configuredEnabled),
    reportedEnabled =
      v.reportedEnabled === null ? null : bool(v.reportedEnabled);
  if (
    (configuration === "matching" &&
      configuredEnabled !== expected.requestedEnabled) ||
    (mcp === "missing" ? reportedEnabled !== null : reportedEnabled === null) ||
    (mcp === "matching" && reportedEnabled !== expected.requestedEnabled)
  )
    invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    configuration,
    mcp,
    configuredEnabled,
    reportedEnabled,
    sessionApplicability: "unverified",
  };
}
export function parseMcpAddOperation(
  raw: unknown,
  expected: McpAddRequest,
): McpAddOperation {
  const v = record(raw, OPERATION_KEYS);
  if (expected.requestedEnabled !== false) invalid();
  operationIdentity(v, expected);
  const parsedTarget = target(v.target, expected),
    rev = v.review === null ? null : review(v.review, expected),
    obs = v.observation === null ? null : observation(v.observation, expected);
  return {
    ...expected,
    target: parsedTarget,
    ...lifecycle(
      v,
      expected,
      {
        hasReview: !!rev,
        hasObservation: !!obs,
        inspectionFailureOutcome: "notDispatched",
        matching: obs?.configuration === "matching" && obs.mcp === "matching",
        different:
          obs?.configuration === "different" ||
          obs?.mcp === "different" ||
          obs?.mcp === "missing",
      },
      MCP_ADD_CODES,
    ),
    review: rev,
    observation: obs,
  };
}
export function parseMcpAddCancellation(
  raw: unknown,
  expected: McpAddRequest,
): McpAddOperation | null {
  const op = cancelledOperation(raw, expected);
  return op === null ? null : parseMcpAddOperation(op, expected);
}
