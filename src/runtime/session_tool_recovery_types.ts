export interface ToolRecoveryTarget {
  agentId: string;
  cwd: string;
  sessionId: string;
}
export type ToolRecoveryResolution = "confirmResult" | "acceptCurrent";
export interface ToolRecoveryConfiguration {
  complete: true;
  items: {
    name: string;
    kind: "builtin" | "platform" | "http";
    address: string | null;
  }[];
}
export interface ToolRecoveryInspection {
  target: ToolRecoveryTarget;
  pending: boolean;
  operationId: string | null;
  action: "add" | "remove" | null;
  outcome: "none" | "busy" | "closing" | "unchanged" | "applied" | "changed";
  canConfirm: boolean;
  reviewId: string | null;
  connectionId: string | null;
  resolution: ToolRecoveryResolution | null;
  configuration: ToolRecoveryConfiguration | null;
}
export interface ToolRecoveryConfirmation {
  target: ToolRecoveryTarget;
  resolved: true;
  operationId: string;
  reviewId: string;
  connectionId: string;
  requiresReopen: true;
  resolution: ToolRecoveryResolution;
}
const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 8192 &&
  !/[\u0000-\u001f\u007f]/.test(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
function configuration(value: unknown): ToolRecoveryConfiguration {
  if (
    !record(value) ||
    !exact(value, ["complete", "items"]) ||
    value.complete !== true ||
    !Array.isArray(value.items) ||
    value.items.length > 256
  )
    throw new Error("invalidResponse");
  return {
    complete: true,
    items: value.items.map((item) => {
      if (
        !record(item) ||
        !exact(item, ["name", "kind", "address"]) ||
        !id(item.name) ||
        new TextEncoder().encode(item.name).length > 256 ||
        /[\u202a-\u202e\u2066-\u2069]/.test(item.name) ||
        !["builtin", "platform", "http"].includes(String(item.kind))
      )
        throw new Error("invalidResponse");
      if (item.kind === "http") {
        if (!id(item.address) || item.address.length > 4096)
          throw new Error("invalidResponse");
        let url: URL;
        try {
          url = new URL(item.address);
        } catch {
          throw new Error("invalidResponse");
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          !url.hostname ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !["/", "/mcp"].includes(url.pathname) ||
          url.href !== item.address
        )
          throw new Error("invalidResponse");
      } else if (item.address !== null) throw new Error("invalidResponse");
      return {
        name: item.name,
        kind: item.kind as "builtin" | "platform" | "http",
        address: item.address as string | null,
      };
    }),
  };
}
export const sameToolRecoveryTarget = (
  v: unknown,
  target: ToolRecoveryTarget,
): boolean =>
  record(v) &&
  Object.entries(target).every(([key, value]) => id(value) && v[key] === value);

export function parseToolRecoveryInspection(
  raw: unknown,
  target: ToolRecoveryTarget,
): ToolRecoveryInspection {
  if (
    !record(raw) ||
    !sameToolRecoveryTarget(raw.target, target) ||
    typeof raw.pending !== "boolean" ||
    typeof raw.canConfirm !== "boolean" ||
    !["none", "busy", "closing", "unchanged", "applied", "changed"].includes(
      String(raw.outcome),
    )
  )
    throw new Error("invalidResponse");
  const resolution =
    raw.resolution === undefined
      ? raw.canConfirm && raw.outcome !== "changed"
        ? "confirmResult"
        : null
      : raw.resolution;
  const reviewed =
    raw.configuration == null ? null : configuration(raw.configuration);
  if (!raw.pending) {
    if (
      raw.outcome !== "none" ||
      raw.canConfirm ||
      raw.operationId !== null ||
      raw.action !== null ||
      raw.reviewId !== null ||
      raw.connectionId !== null ||
      resolution !== null ||
      reviewed !== null
    )
      throw new Error("invalidResponse");
  } else if (
    !id(raw.operationId) ||
    !["add", "remove"].includes(String(raw.action)) ||
    raw.outcome === "none" ||
    (raw.canConfirm
      ? !["unchanged", "applied", "changed"].includes(String(raw.outcome)) ||
        !id(raw.reviewId) ||
        !id(raw.connectionId) ||
        (raw.outcome === "changed"
          ? resolution !== "acceptCurrent" || !reviewed
          : resolution !== "confirmResult" || reviewed !== null)
      : raw.reviewId !== null ||
        (raw.connectionId !== null && !id(raw.connectionId)) ||
        resolution !== null ||
        reviewed !== null)
  )
    throw new Error("invalidResponse");
  return {
    target: { ...target },
    pending: raw.pending,
    operationId: raw.operationId as string | null,
    action: raw.action as ToolRecoveryInspection["action"],
    outcome: raw.outcome as ToolRecoveryInspection["outcome"],
    canConfirm: raw.canConfirm,
    reviewId: raw.reviewId as string | null,
    connectionId: raw.connectionId as string | null,
    resolution: resolution as ToolRecoveryResolution | null,
    configuration: reviewed,
  };
}

export function parseToolRecoveryConfirmation(
  raw: unknown,
  inspected: ToolRecoveryInspection,
): ToolRecoveryConfirmation {
  if (
    !record(raw) ||
    !sameToolRecoveryTarget(raw.target, inspected.target) ||
    !inspected.canConfirm ||
    raw.resolved !== true ||
    raw.requiresReopen !== true ||
    raw.operationId !== inspected.operationId ||
    raw.reviewId !== inspected.reviewId ||
    raw.connectionId !== inspected.connectionId ||
    (raw.resolution ?? "confirmResult") !== inspected.resolution
  )
    throw new Error("invalidResponse");
  return {
    target: { ...inspected.target },
    resolved: true,
    operationId: inspected.operationId!,
    reviewId: inspected.reviewId!,
    connectionId: inspected.connectionId!,
    requiresReopen: true,
    resolution: inspected.resolution!,
  };
}
