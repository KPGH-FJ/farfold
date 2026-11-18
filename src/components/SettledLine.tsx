import type { MouseEventHandler } from "react";
import type { ThreadItem } from "../runtime/session_types";
import type { RoundResult } from "../runtime/round_result";
import { maintenanceLabel } from "../runtime/compaction_strings";
import { STRINGS } from "../runtime/strings";
import { timeLabel } from "./thread-items";

export function SettledLine({
  item,
  artifactCount,
  result,
  onOpenArtifacts,
}: {
  item: Extract<ThreadItem, { kind: "settled" }>;
  artifactCount: number;
  result?: RoundResult;
  onOpenArtifacts: MouseEventHandler<HTMLButtonElement>;
}) {
  const maintenance = maintenanceLabel(result);
  const { ownedTerminalExitCount = 0 } = item;
  const label =
    item.status === "done"
      ? (maintenance ??
        (result === "none"
          ? STRINGS.thread.noResult
          : result === "pending"
            ? STRINGS.thread.resultPending
            : result === "tool"
              ? STRINGS.thread.ended
              : STRINGS.thread.done))
      : item.status === "stopped"
        ? STRINGS.thread.stopped
        : item.status === "unknown"
          ? STRINGS.thread.unknown
          : STRINGS.thread.failed;
  const cls =
    item.status === "done"
      ? result === "none"
        ? "warn"
        : result === "tool" || result === "pending" || maintenance
          ? undefined
          : "ok"
      : item.status === "unknown"
        ? "warn"
        : "no";
  const reasonLabel =
    item.stopReason && item.stopReason !== "end_turn"
      ? STRINGS.thread.stopReasonLabel(item.stopReason)
      : null;
  return (
    <>
      <div className="settled">
        <span className={cls}>
          {item.status === "done"
            ? result === "none"
              ? "! "
              : result === "pending"
                ? "… "
                : result === "tool" || maintenance
                  ? "· "
                  : "✓ "
            : item.status === "stopped"
              ? "■ "
              : "✗ "}
          {label}
        </span>
        {reasonLabel && reasonLabel !== label && (
          <span className="tick">{reasonLabel}</span>
        )}
        {ownedTerminalExitCount > 0 && (
          <span role="status">
            {STRINGS.thread.ownedTerminalExit(ownedTerminalExitCount)}
          </span>
        )}
        {item.error && <span className="no">{item.error}</span>}
        <span>{timeLabel(item.time)}</span>
      </div>
      {item.status === "done" && result === "none" && (
        <p className="completion-note" role="status">
          {STRINGS.thread.noResultNote}
        </p>
      )}
      {artifactCount > 0 && (
        <button
          type="button"
          className="round-sum round-artifacts"
          onClick={onOpenArtifacts}
        >
          {STRINGS.thread.roundArtifacts(artifactCount)}
        </button>
      )}
    </>
  );
}
