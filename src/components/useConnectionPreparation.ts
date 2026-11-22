import { useEffect, useRef, useState } from "react";
import {
  getAgentPreparation,
  type PreparationInfo,
} from "../runtime/preparation";
import { PREPARATION_ACTION_STRINGS } from "../runtime/preparation_action_strings";
import { uiError } from "../runtime/ui_error";

export function useConnectionPreparation(
  agentId: string,
  program: string | undefined,
  declarationsReady: boolean,
  enabled = true,
) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    target: string;
    info?: PreparationInfo;
    error?: string;
  }>();
  const pending = useRef<
    { target: string; info: Promise<PreparationInfo | undefined> } | undefined
  >(undefined);
  const target = JSON.stringify([
    agentId,
    program,
    declarationsReady,
    revision,
  ]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const read = getAgentPreparation(agentId)
      .then((info) => {
        if (current) setResult({ target, info });
        return info;
      })
      .catch((reason) => {
        if (current)
          setResult({
            target,
            error: uiError(reason, PREPARATION_ACTION_STRINGS.loadFailed),
          });
        return undefined;
      });
    const owner = { target, info: read };
    pending.current = owner;
    return () => {
      current = false;
      if (pending.current === owner) pending.current = undefined;
    };
  }, [agentId, target, enabled]);

  const ready = enabled && result?.target === target;
  return {
    info: ready ? result.info : undefined,
    error: ready ? result.error : undefined,
    loading: enabled && !ready,
    async resolveInfo() {
      const owner = pending.current;
      if (!enabled || owner?.target !== target) return undefined;
      const value = await owner.info;
      return pending.current === owner ? value : undefined;
    },
    retry: () => setRevision((current) => current + 1),
  };
}
