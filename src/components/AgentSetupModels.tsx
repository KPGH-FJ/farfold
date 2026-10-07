import { ACCESS_STRINGS as S } from "../runtime/access_strings";
import { AGENT_SETUP_STRINGS as M } from "../runtime/agent_setup_strings";
import { STRINGS } from "../runtime/strings";
import { R5_SETUP_STRINGS as R } from "../runtime/r5_setup_strings";
import { protectedConfigOptions } from "../runtime/protected_config";
import { configValueLabel } from "../runtime/sessions";
import type { ConversationRepairContext } from "../runtime/agent_repair";
import { ModelPicker } from "./ModelPicker";
import { additionalModelRows } from "./ModelConfigRows";
import { isReasoningOption } from "./ReasoningControl";
import type { ConfigOptionView } from "../runtime/session_types";

/** Step 2 review of a repaired conversation's recorded configuration. */
export function agentSetupModelReview({
  conversation,
  source,
  serviceLabel,
  displayLocation,
}: {
  conversation: ConversationRepairContext;
  source?: string;
  serviceLabel?: string;
  displayLocation?: string | null;
}) {
  return (
    <section className="agent-setup-selection">
      <h3>{M.model}</h3>
      <p className="agent-setup-subtitle">{STRINGS.repair.modelLocked}</p>
      <dl className="agent-setup-review">
        <div>
          <dt>{S.source}</dt>
          <dd>
            {source
              ? (serviceLabel ?? STRINGS.service.unavailable)
              : S.existing}
          </dd>
        </div>
        {conversation.recordedModel && (
          <div>
            <dt>{STRINGS.repair.recordedModel}</dt>
            <dd>{conversation.recordedModel}</dd>
          </div>
        )}
        {protectedConfigOptions(
          conversation.configOptions,
          conversation.protectedIds,
        ).map((option) => (
          <div key={option.id}>
            <dt>{option.name}</dt>
            <dd>{configValueLabel(option)}</dd>
          </div>
        ))}
        {!conversation.configOptions.length && (
          <div>
            <dt>{S.model}</dt>
            <dd>{STRINGS.repair.unknownModel}</dd>
          </div>
        )}
        <div>
          <dt>{S.workFolder}</dt>
          <dd>{displayLocation}</dd>
        </div>
      </dl>
    </section>
  );
}

/** The current access choice recap shown while picking models. */
export function agentSetupCurrentSelection({
  name,
  apiChoice,
  serviceLabel,
  displayLocation,
}: {
  name: string;
  apiChoice: boolean;
  serviceLabel?: string;
  displayLocation?: string | null;
}) {
  return (
    <details className="journey-details">
      <summary>{R.currentSelection}</summary>
      <dl className="agent-setup-review">
        <div>
          <dt>{S.title}</dt>
          <dd>{name}</dd>
        </div>
        <div>
          <dt>{S.source}</dt>
          <dd>{apiChoice ? (serviceLabel ?? S.chooseService) : S.existing}</dd>
        </div>
        <div>
          <dt>{S.workFolder}</dt>
          <dd title={displayLocation ?? ""}>
            {displayLocation ?? S.defaultDirectoryError}
          </dd>
        </div>
      </dl>
    </details>
  );
}

/** The optional conversation-test disclosure on the model step. */
export function agentSetupTestNote({
  open,
  label,
  prompt,
  reply,
  error,
  passed,
  action,
  startDisabled,
  reprepareDisabled,
  showStop,
  onStartTest,
  onPrepare,
  onStop,
  onOpenTest,
  closeHint,
  openingHint,
}: {
  open: boolean;
  label: string;
  prompt?: string | null;
  reply?: string | null;
  error?: string | null;
  passed: boolean;
  /** Primary action shown while the disclosure is interactive. */
  action: "start" | "reprepare" | null;
  startDisabled: boolean;
  reprepareDisabled: boolean;
  showStop: boolean;
  onStartTest: () => void;
  onPrepare: () => void;
  onStop: () => void;
  onOpenTest?: () => void;
  closeHint: boolean;
  openingHint: boolean;
}) {
  return (
    <details className="agent-setup-test-note" open={open ? true : undefined}>
      <summary>{S.optionalTest}</summary>
      <h4 role="status">{label}</h4>
      <p>{S.conversationTestHint}</p>
      {prompt && (
        <details className="agent-test-message" open>
          <summary>{S.testMessage}</summary>
          <p>{prompt}</p>
        </details>
      )}
      {error && (
        <p role="alert" className="ac-error">
          {error}
        </p>
      )}
      {reply && (
        <details className="agent-test-message" open>
          <summary>{S.testActualReply}</summary>
          <pre>{reply}</pre>
        </details>
      )}
      <div className="agent-test-actions">
        {action === "start" ? (
          <button
            className="btn btn-primary"
            disabled={startDisabled}
            onClick={onStartTest}
          >
            {S.testInConversation}
          </button>
        ) : (
          action === "reprepare" && (
            <button
              className="btn btn-ghost"
              disabled={reprepareDisabled}
              onClick={onPrepare}
            >
              {passed ? S.testChangeOptions : S.testReprepare}
            </button>
          )
        )}
        {showStop && (
          <button className="btn btn-ghost" onClick={onStop}>
            {S.testStop}
          </button>
        )}
        {onOpenTest && (
          <button className="btn btn-ghost" onClick={onOpenTest}>
            {S.testOpen}
          </button>
        )}
      </div>
      {closeHint && <p className="agent-setup-note">{S.testCloseHint}</p>}
      {openingHint && <p className="agent-setup-note">{S.testModelLoading}</p>}
      <p className="agent-setup-note">
        {passed ? S.readyScope : S.untestedReturnHint}
      </p>
    </details>
  );
}

/** Editable model and reasoning options for the current test draft. */
export function agentSetupModelOptions({
  apiChoice,
  model,
  options,
  fieldsetDisabled,
  fieldsDisabled,
  onPick,
}: {
  apiChoice: boolean;
  model: ConfigOptionView | null;
  options: ConfigOptionView[];
  fieldsetDisabled: boolean;
  fieldsDisabled: boolean;
  onPick: (id: string, value: string) => void;
}) {
  return (
    <fieldset className="agent-setup-options" disabled={fieldsetDisabled}>
      {!apiChoice &&
        (model ? (
          <div className="so-row">
            <span className="so-name">{S.model}</span>
            <ModelPicker
              option={model}
              disabled={fieldsDisabled}
              onPick={(value) => onPick(model.id, value)}
            />
          </div>
        ) : (
          <p className="auth-note">{S.testModelUnspecified}</p>
        ))}
      {additionalModelRows({
        options,
        primaryId: model?.id,
        disabled: fieldsDisabled,
        onPick,
      })}
      {options.filter(isReasoningOption).map((option) => (
        <label className="so-row agent-setup-reasoning" key={option.id}>
          <span className="so-name">{option.name}</span>
          {option.type === "select" && option.options.length ? (
            <select
              aria-label={option.name}
              title={option.description}
              value={String(option.currentValue ?? "")}
              disabled={fieldsDisabled}
              onChange={(event) => onPick(option.id, event.target.value)}
            >
              {!option.options.some(
                (item) => item.value === option.currentValue,
              ) && (
                <option value={String(option.currentValue ?? "")} disabled>
                  {configValueLabel(option)}
                </option>
              )}
              {option.options.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{configValueLabel(option)}</span>
          )}
        </label>
      ))}
    </fieldset>
  );
}
