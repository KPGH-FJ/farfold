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
  card,
  agents,
  inventory,
  installation,
  connected,
  registered,
  needsProgramInstall,
  prerequisitesReady,
  installPrerequisitesReady,
  busy,
  authBusy,
  operationPending,
  progress,
  intent,
  removeConfirm,
  onRemoveConfirm,
  onConnect,
  onDisconnect,
  onClose,
  importControl,
}: {
  card: AgentCardModel;
  agents: AgentsState;
  inventory: ProgramInventory;
  installation: ReturnType<typeof useInstallationReview>;
  setupStep: number;
  connected: boolean;
  registered: boolean;
  needsProgramInstall: boolean;
  prerequisitesReady: boolean;
  installPrerequisitesReady: boolean;
  busy: boolean;
  authBusy: boolean;
  operationPending: boolean;
  progress: { label: string; canCancelInstall: boolean } | null;
  intent: "use" | "manage";
  removeConfirm: boolean;
  onRemoveConfirm: (value: boolean) => void;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<boolean>;
  onClose: () => void;
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
            card={card}
            agents={agents}
            inventory={inventory}
            prerequisitesReady={prerequisitesReady}
            onConnect={() => onConnect()}
            onDisconnect={onDisconnect}
            connectDisabled={
              busy || authBusy || operationPending || !prerequisitesReady
            }
            disconnectDisabled={busy || authBusy || operationPending}
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
        {intent === "manage" && registered && !connected && (
          <details className="agent-manage-actions program-remove-access">
            <summary>{R.removeAccess}</summary>
            <button
              className="btn btn-text"
              disabled={busy || authBusy || operationPending || connected}
              onClick={() => onRemoveConfirm(true)}
            >
              {STRINGS.access.remove}
            </button>
            {removeConfirm && (
              <div className="access-confirm" role="alert">
                <p>{STRINGS.access.removeHint}</p>
                <button
                  className="btn btn-ghost"
                  disabled={busy || authBusy || operationPending || connected}
                  onClick={() =>
                    void agents.remove(card.id).then((ok) => {
                      if (ok) onClose();
                    })
                  }
                >
                  {STRINGS.access.confirmRemove}
                </button>
                <button
                  className="btn btn-text"
                  onClick={() => onRemoveConfirm(false)}
                >
                  {STRINGS.access.cancel}
                </button>
              </div>
            )}
          </details>
        )}
      </div>
      {intent === "manage" && importControl}
    </>
  );
}
