import { useRef, useState } from "react";
import type { AgentCardModel } from "../runtime/agents";
import {
  pendingPreparationRead,
  preparationFor,
  preparationProgram,
} from "../runtime/agent_preparation";
import {
  authenticationActivity,
  captureProgramAuthentication,
  currentAuthenticationRequired,
  useAuthenticationActivity,
} from "../runtime/authentication";
import type { PreparationDraftTarget } from "../runtime/draft_preparation";
import { newConversationChoice } from "../runtime/drafts";
import { PREPARATION_ACTION_STRINGS as S } from "../runtime/preparation_action_strings";

/** Offer a model-options check for the original draft after confirmed cancellation. */
export function ExistingSettingsRecheck({
  card,
  cwd,
  begin,
  onChecked,
  onReview,
}: {
  card: AgentCardModel;
  cwd: string;
  begin: () => PreparationDraftTarget | null;
  onChecked: () => void;
  onReview: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "checking" | "review">("idle");
  const working = useRef(false);
  const job = useAuthenticationActivity(card.id);
  const program = preparationProgram(card);
  const current = useRef({ program, cwd });
  current.current = { program, cwd };
  if (
    job?.phase !== "cancelled" ||
    job.operation.kind !== "preparation" ||
    job.operation.purpose !== "service_configuration" ||
    job.target.cwd !== cwd ||
    job.target.source ||
    job.terminalOutcome?.kind !== "ended" ||
    !job.terminalOutcome.cancelled ||
    !Object.keys(newConversationChoice.config).length
  )
    return null;

  const check = async () => {
    const activity = authenticationActivity(card.id);
    if (
      working.current ||
      activity.getSnapshot() !== job ||
      !pendingPreparationRead({ agentId: card.id, cwd }) ||
      newConversationChoice.agentId !== card.id ||
      newConversationChoice.service
    )
      return;
    const origin = begin();
    if (!origin) return;
    if (origin.cwd !== cwd) {
      origin.retire();
      return;
    }
    const programObserver = captureProgramAuthentication(card.id);
    const ownsDraft = () =>
      origin.isCurrent() &&
      programObserver.current() &&
      current.current.program === program &&
      current.current.cwd === cwd &&
      activity.getSnapshot() === job &&
      !currentAuthenticationRequired(card.id, cwd);
    const controller = preparationFor(card.id);
    working.current = true;
    setStatus("checking");
    try {
      const confirmed = await controller.recheckExistingDraft(
        {
          agentId: card.id,
          agentName: card.name,
          cwd,
          program,
          service: null,
          config: structuredClone(newConversationChoice.config),
        },
        ownsDraft,
      );
      if (confirmed) onChecked();
      else setStatus("review");
    } finally {
      working.current = false;
      origin.retire();
    }
  };

  return (
    <div className="auth-note">
      {status === "review" && <p role="status">{S.recheckNeedsReview}</p>}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={status === "checking"}
        onClick={() => void check()}
      >
        {status === "checking" ? S.recheckingSettings : S.recheckSettings}
      </button>
      {status === "review" && (
        <button type="button" className="btn btn-text" onClick={onReview}>
          {S.models}
        </button>
      )}
    </div>
  );
}
