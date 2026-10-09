import type { ThreadItem } from "./session_types";

/** Session-local display only. Nothing here becomes Agent history or metadata. */
export interface CompactionView {
  kind: "compaction";
  id: string;
  compactionId: string;
  status: string;
  summary: unknown[];
  error?: string;
  meta?: Record<string, unknown>;
  observation?: "unknown";
  /** Current patch and chunk details, discarded when their content is replaced. */
  details: Record<string, unknown>;
  summaryDetails: unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function compactionTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function block(value: unknown): boolean {
  if (!record(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  // Non-text and future blocks remain intact; shared content rendering may
  // recognize them, otherwise details still expose the supplied value.
  return true;
}

/** False leaves the whole malformed/out-of-order envelope in the raw view. */
export function applyCompaction(
  items: ThreadItem[],
  update: Record<string, unknown>,
  nextId: () => string,
): boolean {
  if (typeof update.compactionId !== "string") return false;
  const existing = items.find(
    (item): item is CompactionView =>
      item.kind === "compaction" && item.compactionId === update.compactionId,
  );
  if (update.sessionUpdate === "compaction_summary_chunk") {
    if (
      !existing ||
      existing.status !== "in_progress" ||
      existing.observation ||
      !block(update.content)
    )
      return false;
    existing.summary.push(update.content);
    existing.summaryDetails.push(update);
    return true;
  }
  if (typeof update.status !== "string") return false;
  if (
    Object.hasOwn(update, "summary") &&
    update.summary !== null &&
    (!Array.isArray(update.summary) ||
      !update.summary.every(block) ||
      (update.summary.length > 0 && update.status !== "completed"))
  )
    return false;
  if (
    Object.hasOwn(update, "error") &&
    update.error !== null &&
    (typeof update.error !== "string" || update.status !== "failed")
  )
    return false;
  if (
    Object.hasOwn(update, "_meta") &&
    update._meta !== null &&
    !record(update._meta)
  )
    return false;
  // An Agent-owned ID cannot describe a second lifecycle. Repeated terminal
  // patches/replay are allowed, conflicting transitions remain raw evidence.
  if (
    existing &&
    compactionTerminal(existing.status) &&
    existing.status !== update.status
  )
    return false;
  const item: CompactionView = existing ?? {
    kind: "compaction",
    id: nextId(),
    compactionId: update.compactionId,
    status: update.status,
    summary: [],
    details: {},
    summaryDetails: [],
  };
  item.status = update.status;
  if (compactionTerminal(item.status)) delete item.observation;
  if (Object.hasOwn(update, "summary")) {
    item.summary =
      update.summary === null ? [] : [...(update.summary as unknown[])];
    item.summaryDetails = [];
  }
  if (Object.hasOwn(update, "error")) {
    if (update.error === null) delete item.error;
    else item.error = update.error as string;
  }
  if (Object.hasOwn(update, "_meta")) {
    if (update._meta === null) delete item.meta;
    else item.meta = update._meta as Record<string, unknown>;
  }
  item.details = { ...item.details, ...update };
  if (!existing) items.push(item);
  return true;
}

export function loseCompactionObservation(items: ThreadItem[]): void {
  for (const item of items) {
    if (item.kind === "compaction" && !compactionTerminal(item.status))
      item.observation = "unknown";
  }
}

export type MaintenanceResult =
  | "maintenance"
  | "maintenance_pending"
  | "maintenance_failed"
  | "maintenance_unknown";
export function maintenanceResult(
  items: readonly CompactionView[],
): MaintenanceResult | null {
  if (!items.length) return null;
  if (
    items.some(
      (item) =>
        item.observation ||
        (!compactionTerminal(item.status) && item.status !== "in_progress"),
    )
  )
    return "maintenance_unknown";
  if (items.some((item) => item.status === "in_progress"))
    return "maintenance_pending";
  if (items.some((item) => item.status !== "completed"))
    return "maintenance_failed";
  return "maintenance";
}
