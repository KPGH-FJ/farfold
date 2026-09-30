import type { AgentBusy, InstallProgress } from "./agents";
import { STRINGS } from "./strings";

function byteSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${bytes.toFixed(unit === 0 ? 0 : 1).replace(/\.0$/, "")} ${units[unit]}`;
}

/** Render reported measurements only during download; other stage labels stay intact. */
export function installProgressLabel(
  progress: InstallProgress | undefined,
  stageLabel: string,
): string {
  const bytes = progress?.bytes;
  if (
    progress?.stage !== "download" ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    return stageLabel;
  const total = progress.total;
  const size = STRINGS.install.downloaded(
    byteSize(bytes),
    typeof total === "number" &&
      Number.isSafeInteger(total) &&
      total > 0 &&
      total >= bytes
      ? byteSize(total)
      : undefined,
  );
  return `${stageLabel} ${size}`;
}

/** Shared presentation of the existing task, never a second task lifecycle. */
export function programProgress(
  busy: AgentBusy | null | undefined,
  progress?: InstallProgress,
): { label: string; canCancelInstall: boolean } | null {
  if (busy === "connect")
    return { label: STRINGS.agents.connecting, canCancelInstall: false };
  if (busy !== "install") return null;
  const stage = progress?.stage;
  // A completed attempt's stage can survive until the new first progress event.
  const label =
    stage && stage !== "stopped" && stage !== "ready"
      ? (STRINGS.install.stages[stage] ?? STRINGS.agents.installing)
      : STRINGS.agents.installing;
  return {
    label: installProgressLabel(progress, label),
    canCancelInstall: true,
  };
}
