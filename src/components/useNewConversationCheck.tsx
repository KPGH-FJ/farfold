import { useEffect, useRef, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import { preparationProgram } from "../runtime/agent_preparation";
import { savedOfficialReadOnlyTarget } from "../runtime/official_readonly_check";
import { ZERO_SEND_STRINGS as S } from "../runtime/conversation_access";
import { threads } from "../runtime/sessions";
import { setupStorage } from "../runtime/setup_storage";
import { useConnectionPreparation } from "./useConnectionPreparation";

/** A deliberate open from the ordinary new-conversation page, independent of sending. */
export function useNewConversationCheck({
  agent,
  cwd,
  eligible,
  allowed,
  onOpened,
}: {
  agent?: AgentCardModel;
  cwd: string | null;
  eligible: boolean;
  allowed: boolean;
  onOpened: (key: string) => void;
}) {
  const program = agent && preparationProgram(agent);
  const agentId = agent?.id ?? "";
  const enabled = eligible && !!agent;
  const { info, resolveInfo } = useConnectionPreparation(
    agentId,
    program,
    false,
    enabled,
  );
  const check = info?.officialConversationCheck;
  const selection = check && setupStorage.confirmedSelection(agentId);
  const target =
    cwd && selection && !selection.service
      ? savedOfficialReadOnlyTarget(agentId, cwd, check, selection.config)
      : null;
  const owner = target ? JSON.stringify([program, target]) : "";
  const live = useRef({ owner, allowed, onOpened });
  live.current = { owner, allowed, onOpened };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const running = useRef(false);
  const [opening, setOpening] = useState(false);
  const [failedOwner, setFailedOwner] = useState("");

  const open = async () => {
    if (
      !target ||
      !check ||
      !live.current.allowed ||
      running.current ||
      live.current.owner !== owner
    )
      return;
    running.current = true;
    setOpening(true);
    setFailedOwner("");
    try {
      const opened = await threads.open({
        agentId: target.agentId,
        cwd: target.cwd,
        configOptions: {
          [check.modelOptionId]: target.model,
          [check.reasoningOptionId]: target.reasoningEffort,
        },
        fresh: true,
        openPurpose: "codex-official-check",
      });
      const receipt = opened.conversationAccess?.receipt;
      if (
        receipt?.model !== target.model ||
        receipt?.effort !== target.reasoningEffort
      )
        throw new Error(S.openFailed);
      if (
        mounted.current &&
        live.current.owner === owner &&
        live.current.allowed
      )
        live.current.onOpened(opened.key);
    } catch {
      if (mounted.current && live.current.owner === owner)
        setFailedOwner(owner);
    } finally {
      running.current = false;
      if (mounted.current) setOpening(false);
    }
  };

  return {
    blocksOrdinary: Boolean(check),
    allowsOrdinary: async () =>
      !(await resolveInfo())?.officialConversationCheck,
    action:
      check && cwd ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!allowed || !target || opening}
          onClick={() => void open()}
        >
          {opening ? S.opening : S.open}
        </button>
      ) : null,
    notice:
      check && cwd && !target
        ? S.notReady
        : owner && failedOwner === owner
          ? S.openFailed
          : null,
  };
}
