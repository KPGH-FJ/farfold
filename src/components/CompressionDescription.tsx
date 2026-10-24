import type { ReportedDetails } from "../runtime/reported_details";
import { COMPACTION as C } from "../runtime/compaction_strings";

type Phase = "progress" | "done" | "noop";
interface CompressionReport {
  phase: Phase;
  originalTokenCount?: number;
  newTokenCount?: number;
  originalTokenCountIsEstimated?: boolean;
  newTokenCountIsEstimated?: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Description of retained source data only, never a work or request owner. */
function compressionReport(
  details?: ReportedDetails,
): CompressionReport | null {
  const meta = details?.["/update/_meta"];
  if (!record(meta) || meta.source !== "slash_command") return null;
  const report = meta.contextCompression;
  if (
    !record(report) ||
    typeof report.phase !== "string" ||
    !["progress", "done", "noop"].includes(report.phase)
  )
    return null;
  const counts = ["originalTokenCount", "newTokenCount"] as const;
  const flags = [
    "originalTokenCountIsEstimated",
    "newTokenCountIsEstimated",
  ] as const;
  const suppliedCounts = counts.filter((key) => Object.hasOwn(report, key));
  if (
    (suppliedCounts.length !== 0 && suppliedCounts.length !== 2) ||
    suppliedCounts.some(
      (key) =>
        !Number.isSafeInteger(report[key]) || (report[key] as number) < 0,
    ) ||
    flags.some(
      (key) => Object.hasOwn(report, key) && typeof report[key] !== "boolean",
    )
  )
    return null;
  return report as unknown as CompressionReport;
}

/** Both replayed and current messages remain descriptions, without side effects. */
export function CompressionDescription({
  details,
}: {
  details?: ReportedDetails;
}) {
  const report = compressionReport(details);
  if (!report) return null;
  const label =
    report.phase === "progress"
      ? C.inProgress
      : report.phase === "done"
        ? C.completed
        : C.notNeeded;
  const token = (value: number, estimated?: boolean) =>
    `${value}${estimated ? C.estimated : ""}`;
  return (
    <div>
      <p className="compaction-note" data-find-block>
        {C.reportedStatus}：{label}
      </p>
      {report.phase === "done" &&
        report.originalTokenCount !== undefined &&
        report.newTokenCount !== undefined && (
          <p className="compaction-note" data-find-block>
            {C.reportedTokens}：
            {`${token(report.originalTokenCount, report.originalTokenCountIsEstimated)} → ${token(report.newTokenCount, report.newTokenCountIsEstimated)}`}
          </p>
        )}
    </div>
  );
}
