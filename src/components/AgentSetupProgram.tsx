import type { ReactNode } from "react";
import type { AgentCardModel, AgentsState } from "../runtime/agents";
import {
  ACCESS_STRINGS as S,
  installationUnavailableLabel,
} from "../runtime/access_strings";
import { STRINGS } from "../runtime/strings";
import {
  AgentInstallOptions,
  useInstallationReview,
} from "./AgentInstallOptions";
import { ProgramManager, type ProgramInventory } from "./ProgramManager";
import { R5_PROGRAM_STRINGS as R } from "../runtime/r5_program_strings";

/** Present the shared program controls; execution and ownership stay in setup. */
export function agentSetupProgram({
  active = true,
  card,
  agents,
  inventory,
  installation,
  registered,
  needsProgramInstall,
  prerequisitesReady,
  installPrerequisitesReady,
  busy,
  authBusy,
  operationPending,
  progress,
  intent,
  onRemoveAgent,
  onConnect,
  importControl,
}: {
  active?: boolean;
  card: AgentCardModel;
  agents: AgentsState;
  inventory: ProgramInventory;
  installation: ReturnType<typeof useInstallationReview>;
  setupStep: number;
  registered: boolean;
  needsProgramInstall: boolean;
  prerequisitesReady: boolean;
  installPrerequisitesReady: boolean;
  busy: boolean;
  authBusy: boolean;
  operationPending: boolean;
  progress: { label: string; canCancelInstall: boolean } | null;
  intent: "use" | "manage";
  /** Opens the unified removal flow; the dialog itself confirms. */
  onRemoveAgent: () => void;
  onConnect: () => Promise<void>;
  importControl: ReactNode;
}) {
  return (
    <>
      {card.installable && (
        <AgentInstallOptions
          {...installation.fieldProps}
          disabled={busy || authBusy || operationPending}
        />
      )}
      {!registered && (card.registerable || card.installable) && (
        <button
          className={
            card.registerable && !prerequisitesReady
              ? "btn btn-ghost"
              : "btn btn-primary"
          }
          disabled={
            busy ||
            authBusy ||
            operationPending ||
            (card.registerable && !prerequisitesReady) ||
            (needsProgramInstall &&
              (!installPrerequisitesReady || !installation.ready)) ||
            (!card.registerable && !card.installable)
          }
          onClick={() => {
            if (card.registerable && !prerequisitesReady) return;
            void onConnect().catch(() => undefined);
          }}
        >
          {busy
            ? STRINGS.common.loading
            : card.registerable
              ? S.connect
              : S.install}
        </button>
      )}
      {needsProgramInstall &&
        card.installable &&
        !installPrerequisitesReady && (
          <p className="auth-note">{R.prepareDependencies}</p>
        )}
      {progress && (
        <div className="agent-setup-progress" role="status">
          <span>{progress.label}</span>
          {progress.canCancelInstall && (
            <button
              className="btn btn-text"
              onClick={() => void agents.cancelInstall(card.id)}
            >
              {STRINGS.access.cancelOperation}
            </button>
          )}
        </div>
      )}
      {!registered && !card.registerable && !card.installable && (
        <p className="auth-note">
          {installationUnavailableLabel(card.platformAvailable)}
        </p>
      )}
      <div className="agent-setup-management">
        <fieldset
          className="agent-setup-program-guard"
          disabled={authBusy || operationPending}
        >
          <ProgramManager
            active={active}
            card={card}
            agents={agents}
            inventory={inventory}
            prerequisitesReady={prerequisitesReady}
            onConnect={() => onConnect()}
            connectDisabled={
              busy || authBusy || operationPending || !prerequisitesReady
            }
            installDisabled={
              !installation.ready ||
              !installPrerequisitesReady ||
              busy ||
              authBusy ||
              operationPending
            }
            onInstall={async () => {
              const input = installation.read();
              if (
                input === null ||
                !installPrerequisitesReady ||
                busy ||
                authBusy ||
                operationPending
              )
                return false;
              return agents.install(card, input);
            }}
          />
        </fieldset>
        {intent === "manage" && registered && (
          <button
            className="btn btn-ghost"
            disabled={busy || authBusy || operationPending}
            onClick={onRemoveAgent}
          >
            {STRINGS.access.remove}
          </button>
        )}
      </div>
      {intent === "manage" && importControl}
    </>
  );
}
