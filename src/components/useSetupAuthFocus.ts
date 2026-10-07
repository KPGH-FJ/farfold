import { useEffect, useRef } from "react";
import type { AgentSetupProgress } from "./AgentSetup";

/** Focus a newly reported requirement once; later navigation stays with the user. */
export function useSetupAuthFocus({
  active,
  connected,
  required,
  agentId,
  cwd,
  source,
  progress,
  onProgress,
}: {
  active: boolean;
  connected: boolean;
  required: boolean;
  agentId: string;
  cwd: string | null;
  source?: string;
  progress: AgentSetupProgress;
  onProgress: (value: AgentSetupProgress) => void;
}) {
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!required) {
      focused.current = null;
      return;
    }
    const target = JSON.stringify([agentId, cwd, source ?? null]);
    if (
      !active ||
      !connected ||
      !cwd ||
      source ||
      progress.step === 0 ||
      focused.current === target
    )
      return;
    focused.current = target;
    // The method list is the only login stage; execution happens in place.
    const accessStage = "method" as const;
    if (
      progress.step !== 1 ||
      progress.choice !== "login" ||
      progress.accessStage !== accessStage
    )
      onProgress({ ...progress, step: 1, choice: "login", accessStage });
    // Selecting methods or browsing tabs must not refocus an existing requirement.
  }, [active, connected, required, agentId, cwd, source]);
}
