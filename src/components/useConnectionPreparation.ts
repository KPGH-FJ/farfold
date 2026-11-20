import { useEffect, useState } from "react";
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
) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    target: string;
    info?: PreparationInfo;
    error?: string;
  }>();
  const target = JSON.stringify([
    agentId,
    program,
    declarationsReady,
    revision,
  ]);
  useEffect(() => {
    let current = true;
    void getAgentPreparation(agentId)
      .then((info) => {
        if (current) setResult({ target, info });
      })
      .catch((reason) => {
        if (current)
          setResult({
            target,
            error: uiError(reason, PREPARATION_ACTION_STRINGS.loadFailed),
          });
      });
    return () => {
      current = false;
    };
  }, [agentId, target]);

  const ready = result?.target === target;
  return {
    info: ready ? result.info : undefined,
    error: ready ? result.error : undefined,
    loading: !ready,
    retry: () => setRevision((current) => current + 1),
  };
}
