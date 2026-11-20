import { AGENT_SETUP_STRINGS as S } from "../runtime/agent_setup_strings";
import { sameConfigurationSnapshot } from "../runtime/config_check";
import type { PreparationSnapshot } from "../runtime/agent_preparation";
import type { Credential } from "../runtime/credentials";
import type { ThreadState } from "../runtime/session_types";
import { modelConfigOption } from "../runtime/sessions";
import { AgentSelectionReview } from "./AgentSelectionReview";
import type { AgentSetupSelection } from "./AgentSetup";
import type { ReactNode } from "react";

export function agentSetupModelReadNotice({
  mismatch,
  disabled,
  test,
  thread,
  selection,
  services,
  draftReview,
  onConfirm,
  onRestore,
}: {
  mismatch: boolean;
  disabled: boolean;
  test: PreparationSnapshot;
  thread: ThreadState | null;
  selection: AgentSetupSelection;
  services: Credential[];
  draftReview: boolean;
  onConfirm: () => void;
  onRestore?: (id: string, value: string) => void;
}) {
  const model = thread && modelConfigOption(thread.configOptions);
  const original = model && selection.config[model.id];
  const restore =
    mismatch &&
    thread &&
    onRestore &&
    !draftReview &&
    !selection.service &&
    test.phase === "untested" &&
    thread.key === test.threadKey &&
    thread.identity === "draft" &&
    !thread.configuring &&
    !thread.configError &&
    !thread.modelDrift &&
    !thread.sourceError &&
    model?.type === "select" &&
    typeof original === "string" &&
    typeof model.currentValue === "string" &&
    model.currentValue === test.config[model.id] &&
    original !== model.currentValue &&
    model.options.some(({ value }) => value === original) &&
    Object.entries(selection.config).every(
      ([id, value]) =>
        id === model.id ||
        (Object.hasOwn(test.config, id) &&
          sameConfigurationSnapshot(value, test.config[id])),
    )
      ? () => onRestore(model.id, original)
      : undefined;
  return (
    <AgentModelReadNotice
      mismatch={mismatch}
      disabled={disabled}
      onConfirm={onConfirm}
      onRestore={restore}
    >
      {mismatch && thread && (
        <AgentSelectionReview
          before={selection}
          after={{ service: selection.service, config: test.config }}
          services={services}
          options={thread.configOptions}
          draftOnly={draftReview}
        />
      )}
    </AgentModelReadNotice>
  );
}

export function AgentModelReadNotice({
  mismatch,
  disabled,
  onConfirm,
  onRestore,
  children,
}: {
  mismatch: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onRestore?: () => void;
  children?: ReactNode;
}) {
  if (!mismatch) return null;
  return (
    <div className="auth-note" role="alert">
      <p>{S.modelMismatch}</p>
      {children}
      {onRestore && (
        <button
          className="btn btn-text"
          disabled={disabled}
          onClick={onRestore}
        >
          {S.modelRestoreOriginal}
        </button>
      )}
      <button className="btn btn-text" disabled={disabled} onClick={onConfirm}>
        {S.modelAcceptCurrent}
      </button>
    </div>
  );
}
