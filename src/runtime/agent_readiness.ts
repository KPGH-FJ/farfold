import { useEffect, useState } from "react";
import type { AgentCardModel } from "./agents";
import { isAgentReadyForConversation } from "./agent_directory";
import { setupStorage, useSetupStorage } from "./setup_storage";
import {
  authenticationActivity,
  authenticationRequired,
  useAuthentication,
} from "./authentication";
import { authActive } from "./auth_activity";
import {
  pendingPreparationRead,
  preparationFor,
  usePreparationChanges,
} from "./agent_preparation";
import { threads } from "./sessions";

/** Saved user choices survive process shutdown and do not assert live readiness. */
export function hasSavedAgentPreparation(id: string): boolean {
  return setupStorage.completed(id) && !!setupStorage.confirmedSelection(id);
}

/** Uses saved preparation and current blockers, without connecting or sending. */
export function useConversationAgentReadiness(
  cards: AgentCardModel[],
  { cwd = null }: { cwd?: string | null } = {},
) {
  useSetupStorage();
  usePreparationChanges();
  const authentication = useAuthentication();
  const [, redraw] = useState(0);
  const ids = cards
    .map((card) => card.id)
    .sort()
    .join("\n");
  useEffect(() => {
    const unsubscribe = cards.map((card) =>
      authenticationActivity(card.id).subscribe(() => redraw((n) => n + 1)),
    );
    return () => unsubscribe.forEach((off) => off());
  }, [ids]);
  return (id: string) => {
    const card = cards.find((item) => item.id === id);
    if (!card) return false;
    const selection = setupStorage.confirmedSelection(id);
    if (!selection || !hasSavedAgentPreparation(id)) return false;
    const service = selection.service;
    const sources = [service ? JSON.stringify(service) : undefined];
    const preparation = preparationFor(id).getSnapshot();
    const preparedService = preparation.input?.service;
    if (
      service &&
      preparedService?.id === service.id &&
      preparedService.model === service.model &&
      preparedService.revision === service.revision &&
      preparation.threadKey
    ) {
      const source = threads.thread(preparation.threadKey)?.serviceContext;
      if (source) sources.push(source);
    }
    return isAgentReadyForConversation(
      card,
      !authActive(authenticationActivity(id).getSnapshot()) &&
        !pendingPreparationRead({ agentId: id, cwd, service }) &&
        !sources.some((source) =>
          authenticationRequired(authentication, id, cwd, source),
        ),
    );
  };
}
