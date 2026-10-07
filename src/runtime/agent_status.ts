import type { AgentCardModel } from "./agents";
import {
  ACCESS_STRINGS as S,
  installationUnavailableLabel,
} from "./access_strings";
import { PREPARATION_ACTION_STRINGS as C } from "./preparation_action_strings";

export type AgentStatusTone =
  "ready" | "attention" | "error" | "progress" | "neutral";
export interface AgentStatus {
  tone: AgentStatusTone;
  label: string;
}

export interface AgentStatusInput {
  card: AgentCardModel;
  /** In-flight program work label (connect/install progress). */
  progressLabel?: string | null;
  /** An account or service action is still running. */
  accountInProgress?: boolean;
  /** The running account action is service configuration. */
  configuring?: boolean;
  /** A saved choice must be read again before it can start. */
  readRequired?: boolean;
  /** A confirmed authentication requirement exists for this context. */
  authRequired?: boolean;
  /** Setup completed and a usable selection exists. */
  prepared?: boolean;
}

const status = (tone: AgentStatusTone, label: string): AgentStatus => ({
  tone,
  label,
});

/** One status for cards, details, pickers and the setup header. Connection
 *  state stays internal: a usable Agent reads as ready, not as connected. */
export function agentStatus(input: AgentStatusInput): AgentStatus {
  const { card } = input;
  if (input.progressLabel) return status("progress", input.progressLabel);
  if (input.accountInProgress)
    return status(
      "progress",
      input.configuring ? C.inProgress : S.loginInProgress,
    );
  if (input.readRequired) return status("progress", C.readPending);
  if (input.authRequired) return status("attention", S.needLogin);
  if (card.status === "connected" || card.status === "installed") {
    if (!input.prepared) return status("attention", S.setupIncomplete);
    if (card.connectionFailed) return status("error", S.problem);
    return status("ready", S.ready);
  }
  if (card.status === "discovered")
    return status("neutral", S.installedLocally);
  if (!card.installable && !card.registerable)
    return status(
      "neutral",
      installationUnavailableLabel(card.platformAvailable),
    );
  return status("neutral", S.notAdded);
}
