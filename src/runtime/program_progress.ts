import type { AgentBusy, InstallProgress } from "./agents";
import { STRINGS } from "./strings";

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
  return { label, canCancelInstall: true };
}
