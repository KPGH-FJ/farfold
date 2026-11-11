export interface ToolRecoveryTarget {
  agentId: string;
  cwd: string;
  sessionId: string;
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
}
export interface ToolRecoveryConfirmation {
  target: ToolRecoveryTarget;
  resolved: true;
  operationId: string;
  reviewId: string;
  connectionId: string;
  requiresReopen: true;
}
const record = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 8192 &&
  !/[\u0000-\u001f\u007f]/.test(v);
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
  if (!raw.pending) {
    if (
      raw.outcome !== "none" ||
      raw.canConfirm ||
      raw.operationId !== null ||
      raw.action !== null ||
      raw.reviewId !== null ||
      raw.connectionId !== null
    )
      throw new Error("invalidResponse");
  } else if (
    !id(raw.operationId) ||
    !["add", "remove"].includes(String(raw.action)) ||
    raw.outcome === "none" ||
    (raw.canConfirm
      ? !["unchanged", "applied"].includes(String(raw.outcome)) ||
        !id(raw.reviewId) ||
        !id(raw.connectionId)
      : raw.reviewId !== null ||
        (raw.connectionId !== null && !id(raw.connectionId)))
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
    raw.connectionId !== inspected.connectionId
  )
    throw new Error("invalidResponse");
  return {
    target: { ...inspected.target },
    resolved: true,
    operationId: inspected.operationId!,
    reviewId: inspected.reviewId!,
    connectionId: inspected.connectionId!,
    requiresReopen: true,
  };
}
