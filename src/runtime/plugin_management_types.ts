import {
  bool,
  cancelledOperation,
  integer,
  invalid,
  lifecycle,
  one,
  record,
  text,
} from "./extension_change_validation";
import {
  validInventoryDirectory,
  validInventoryId,
} from "./extension_inventory_types";
import {
  SKILL_CHANGE_CODES,
  type SkillChangeCode,
  type SkillChangeOperation,
} from "./skill_management_types";

export type PluginCode = SkillChangeCode;
export const PLUGIN_REASONS = [
  "notConfiguredSource",
  "unsupportedSource",
  "unsafeLabel",
  "unknownPolicy",
  "notAvailable",
  "alreadyInstalled",
  "notInstalled",
] as const;
export type PluginReason = (typeof PLUGIN_REASONS)[number];
export interface PluginPermission {
  availability: "available" | "unavailable";
  reason: PluginReason | null;
}
export interface PluginItem {
  id: number;
  name: string | null;
  marketplaceName: string | null;
  version: string | null;
  reportedInstalled: boolean;
  reportedEnabled: boolean;
  source: "local" | "git" | "gitSubdir" | "npm" | "remote" | "unknown";
  installPolicy:
    "available" | "installedByDefault" | "notAvailable" | "unknown";
  authPolicy: "onInstall" | "onUse" | "unknown";
  install: PluginPermission;
  remove: PluginPermission;
}
export interface PluginCatalog {
  observedAtMs: number;
  scope: "officialSharedPluginConfiguration";
  source: "officialCli";
  complete: boolean;
  sessionApplicability: "unverified";
  items: PluginItem[];
}
export const PLUGIN_SOURCE_REASONS = [
  "unsafeLabel",
  "invalidSource",
  "ambiguousSource",
  "unsupportedSource",
] as const;
export type PluginSourceReason = (typeof PLUGIN_SOURCE_REASONS)[number];
export interface PluginSourceItem {
  id: number;
  name: string | null;
  kind: "local" | "git" | "remote" | "unknown";
  query: {
    availability: "available" | "unavailable";
    reason: PluginSourceReason | null;
  };
}
export interface PluginSourceCatalog {
  observedAtMs: number;
  scope: "officialSharedPluginConfiguration";
  source: "officialCli";
  complete: false;
  sessionApplicability: "unverified";
  items: PluginSourceItem[];
}
export interface PluginReview {
  reviewId: string;
  agentId: string;
  cwd: string;
  target: PluginItem;
  install: boolean;
  observedAtMs: number;
  validForMs: 300000;
  scope: "officialSharedPluginConfiguration";
  sessionApplicability: "unverified";
}
export interface PluginObservation {
  observedAtMs: number;
  reportedInstalled: boolean;
  reportedEnabled: boolean;
  sessionApplicability: "unverified";
}
export interface PluginRequest {
  agentId: string;
  requestId: string;
  cwd: string;
  action:
    "sources" | "inventory" | "inspect" | "install" | "remove" | "recheck";
  sourceRequestId?: string;
  sourceId?: number;
  querySource?: PluginSourceItem;
  target?: PluginItem;
  install?: boolean;
  operationId?: string;
}
export interface PluginOperation {
  agentId: string;
  requestId: string;
  cwd: string;
  action: PluginRequest["action"];
  state: SkillChangeOperation["state"];
  phase: SkillChangeOperation["phase"];
  settled: boolean;
  code: PluginCode | null;
  writeDispatched: boolean;
  writeAck: SkillChangeOperation["writeAck"];
  outcome: SkillChangeOperation["outcome"];
  catalog: PluginCatalog | null;
  review: PluginReview | null;
  observation: PluginObservation | null;
  target: PluginItem | null;
  sources?: PluginSourceCatalog;
}

export function pluginFailure(raw: unknown): PluginCode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).length === 1 &&
    SKILL_CHANGE_CODES.includes(value.code as PluginCode)
    ? (value.code as PluginCode)
    : null;
}
function label(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 256);
  if (/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(result))
    return invalid();
  return result;
}
function permission(raw: unknown): PluginPermission {
  const v = record(raw, ["availability", "reason"]);
  const availability = one(v.availability, ["available", "unavailable"]);
  const reason = v.reason === null ? null : one(v.reason, PLUGIN_REASONS);
  if ((availability === "available") !== (reason === null)) return invalid();
  return { availability, reason };
}
export function parsePluginItem(raw: unknown): PluginItem {
  const v = record(raw, [
    "id",
    "name",
    "marketplaceName",
    "version",
    "reportedInstalled",
    "reportedEnabled",
    "source",
    "installPolicy",
    "authPolicy",
    "install",
    "remove",
  ]);
  const item: PluginItem = {
    id: integer(v.id, 4095),
    name: label(v.name),
    marketplaceName: label(v.marketplaceName),
    version: label(v.version),
    reportedInstalled: bool(v.reportedInstalled),
    reportedEnabled: bool(v.reportedEnabled),
    source: one(v.source, [
      "local",
      "git",
      "gitSubdir",
      "npm",
      "remote",
      "unknown",
    ]),
    installPolicy: one(v.installPolicy, [
      "available",
      "installedByDefault",
      "notAvailable",
      "unknown",
    ]),
    authPolicy: one(v.authPolicy, ["onInstall", "onUse", "unknown"]),
    install: permission(v.install),
    remove: permission(v.remove),
  };
  if (
    (item.install.availability === "available" && item.reportedInstalled) ||
    (item.remove.availability === "available" && !item.reportedInstalled) ||
    ((item.install.availability === "available" ||
      item.remove.availability === "available") &&
      (!item.name ||
        !item.marketplaceName ||
        ["remote", "unknown"].includes(item.source)))
  )
    return invalid();
  return item;
}
export const samePluginItem = (a: PluginItem, b: PluginItem) =>
  JSON.stringify(a) === JSON.stringify(b);

function catalog(raw: unknown): PluginCatalog {
  const v = record(raw, [
    "observedAtMs",
    "scope",
    "source",
    "complete",
    "sessionApplicability",
    "items",
  ]);
  if (!Array.isArray(v.items) || v.items.length > 4096) return invalid();
  const items = v.items.map(parsePluginItem);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    return invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    scope: one(v.scope, ["officialSharedPluginConfiguration"]),
    source: one(v.source, ["officialCli"]),
    complete: bool(v.complete),
    sessionApplicability: one(v.sessionApplicability, ["unverified"]),
    items,
  };
}
function sourceCatalog(raw: unknown): PluginSourceCatalog {
  const v = record(raw, [
    "observedAtMs",
    "scope",
    "source",
    "complete",
    "sessionApplicability",
    "items",
  ]);
  if (!Array.isArray(v.items) || v.items.length > 4096 || v.complete !== false)
    return invalid();
  const items = v.items.map((raw): PluginSourceItem => {
    const value = record(raw, ["id", "name", "kind", "query"]);
    const q = record(value.query, ["availability", "reason"]);
    const availability = one(q.availability, ["available", "unavailable"]);
    const reason =
      q.reason === null ? null : one(q.reason, PLUGIN_SOURCE_REASONS);
    const name = label(value.name);
    if (
      (availability === "available") !== (reason === null) ||
      (availability === "available" && name === null)
    )
      return invalid();
    return {
      id: integer(value.id, 4095),
      name,
      kind: one(value.kind, ["local", "git", "remote", "unknown"]),
      query: { availability, reason },
    };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length)
    return invalid();
  return {
    observedAtMs: integer(v.observedAtMs),
    scope: one(v.scope, ["officialSharedPluginConfiguration"]),
    source: one(v.source, ["officialCli"]),
    complete: false,
    sessionApplicability: one(v.sessionApplicability, ["unverified"]),
    items,
  };
}
function review(raw: unknown, expected: PluginRequest): PluginReview {
  const v = record(raw, [
    "reviewId",
    "agentId",
    "cwd",
    "target",
    "install",
    "observedAtMs",
    "validForMs",
    "scope",
    "sessionApplicability",
  ]);
  const target = parsePluginItem(v.target);
  if (
    !validInventoryId(v.reviewId) ||
    v.agentId !== expected.agentId ||
    v.cwd !== expected.cwd ||
    v.install !== expected.install ||
    v.validForMs !== 300000 ||
    !expected.target ||
    !samePluginItem(target, expected.target)
  )
    return invalid();
  return {
    reviewId: v.reviewId,
    agentId: expected.agentId,
    cwd: expected.cwd,
    target,
    install: bool(v.install),
    observedAtMs: integer(v.observedAtMs),
    validForMs: 300000,
    scope: one(v.scope, ["officialSharedPluginConfiguration"]),
    sessionApplicability: one(v.sessionApplicability, ["unverified"]),
  };
}
export function parsePluginOperation(
  raw: unknown,
  expected: PluginRequest,
): PluginOperation {
  const hasSources =
    !!raw && typeof raw === "object" && Object.hasOwn(raw, "sources");
  const v = record(raw, [
    "agentId",
    "requestId",
    "cwd",
    "action",
    "state",
    "phase",
    "settled",
    "code",
    "writeDispatched",
    "writeAck",
    "outcome",
    "catalog",
    "review",
    "observation",
    "target",
    ...(hasSources ? ["sources"] : []),
  ]);
  if (
    !validInventoryId(expected.requestId) ||
    !validInventoryDirectory(expected.cwd) ||
    v.agentId !== expected.agentId ||
    v.requestId !== expected.requestId ||
    v.cwd !== expected.cwd ||
    v.action !== expected.action
  )
    return invalid();
  const target = v.target === null ? null : parsePluginItem(v.target);
  if (
    ["sources", "inventory"].includes(expected.action)
      ? target !== null
      : target !== null &&
        (!expected.target || !samePluginItem(target, expected.target))
  )
    return invalid();
  const c = v.catalog === null ? null : catalog(v.catalog);
  const r = v.review === null ? null : review(v.review, expected);
  if (hasSources && expected.action !== "sources") return invalid();
  const s = hasSources ? sourceCatalog(v.sources) : null;
  let observation: PluginObservation | null = null;
  if (v.observation !== null) {
    const o = record(v.observation, [
      "observedAtMs",
      "reportedInstalled",
      "reportedEnabled",
      "sessionApplicability",
    ]);
    observation = {
      observedAtMs: integer(o.observedAtMs),
      reportedInstalled: bool(o.reportedInstalled),
      reportedEnabled: bool(o.reportedEnabled),
      sessionApplicability: one(o.sessionApplicability, ["unverified"]),
    };
  }
  if (
    (c !== null && expected.action !== "inventory") ||
    (r !== null && expected.action !== "inspect") ||
    (observation &&
      ["sources", "inventory", "inspect"].includes(expected.action)) ||
    (expected.action !== "inventory" && (r || observation) && !target)
  )
    return invalid();
  const read = ["sources", "inventory", "inspect"].includes(expected.action);
  // Readback flags describe this read-only operation. The controller retains
  // the original confirmation separately, without rewriting its write facts.
  if (
    expected.action === "recheck" &&
    (v.writeDispatched !== false || v.writeAck !== "none")
  )
    return invalid();
  const lifecycleAction =
    expected.action === "sources" ||
    expected.action === "inventory" ||
    expected.action === "inspect"
      ? "inspect"
      : expected.action === "install"
        ? "add"
        : expected.action;
  const facts = lifecycle(
    v,
    {
      ...expected,
      action: lifecycleAction,
      requestedEnabled: expected.install ?? null,
      operationId: expected.operationId ?? null,
    },
    {
      hasReview:
        read &&
        (expected.action === "sources"
          ? s !== null
          : expected.action === "inventory"
            ? c !== null
            : r !== null),
      hasObservation: observation !== null,
      matching:
        !!observation && observation.reportedInstalled === expected.install,
      different:
        !!observation && observation.reportedInstalled !== expected.install,
    },
  );
  return {
    agentId: expected.agentId,
    requestId: expected.requestId,
    cwd: expected.cwd,
    action: expected.action,
    ...facts,
    catalog: c,
    review: r,
    observation,
    target,
    ...(s ? { sources: s } : {}),
  };
}
export function parsePluginCancellation(
  raw: unknown,
  expected: PluginRequest,
): PluginOperation | null {
  const value = cancelledOperation(raw, expected);
  return value === null ? null : parsePluginOperation(value, expected);
}
