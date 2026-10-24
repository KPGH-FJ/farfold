import { useState } from "react";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import "../conversation-redesign.css";
/**
 * 会话选项列表：渲染 Agent 声明的全部 configOptions——select 用分组
 * 下拉（复用 ModelPicker），boolean 用开关，未知类型只读。模型选项仍
 * 只在本轮工作结束、真实声明与恢复核对允许时修改。一个组件覆盖所有 Agent，差异只
 * 来自 configOptions 数据本身。
 */
import { ModelPicker } from "./ModelPicker";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import { isReasoningOption } from "./ReasoningControl";
import {
  configOptionChangeBlocked,
  protectedConfigIds,
} from "../runtime/protected_config";
import { useAuthenticationActivity } from "../runtime/authentication";
import { STRINGS } from "../runtime/strings";
import {
  configValueLabel,
  modelConfigOption,
  threads,
  type ConfigOptionView,
  type ThreadState,
} from "../runtime/sessions";

/** Translate only known common titles; a category can hold unrelated controls. */
function hasStandardModeName(option: ConfigOptionView) {
  const name = option.name.trim().toLowerCase();
  return name === "mode" || name === "session mode";
}

function optionLabel(option: ConfigOptionView) {
  return hasStandardModeName(option) ? STRINGS.options.modeName : option.name;
}

function OptionRow({
  thread,
  option,
}: {
  thread: ThreadState;
  option: ConfigOptionView;
}) {
  useAuthenticationActivity(thread.agentId);
  const [selection, setSelection] = useState<{
    value: unknown;
    baseline: unknown;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const recorded = protectedConfigIds(
    thread.configOptions,
    thread.configCheck?.protectedIds,
  ).has(option.id);
  const disabled = saving || configOptionChangeBlocked(thread, option.id);
  const known =
    option.type === "boolean" ||
    (option.type === "select" && option.options.length > 0);
  const pending =
    selection && Object.is(selection.baseline, option.currentValue)
      ? selection
      : null;
  const proposed = pending?.value ?? option.currentValue;
  const on = proposed === true || proposed === "true";
  const label = optionLabel(option);
  const description =
    option.description?.trim().toLowerCase() === "session permission mode"
      ? STRINGS.options.permissionModeDescription
      : hasStandardModeName(option) &&
          option.description === "Session operating mode"
        ? STRINGS.options.modeDescription
        : option.description || R.descriptionUnknown;
  const choose = (value: unknown) => {
    if (configOptionChangeBlocked(thread, option.id)) return;
    setFailed(false);
    setSelection(
      Object.is(value, option.currentValue)
        ? null
        : { value, baseline: option.currentValue },
    );
  };
  const change = async () => {
    if (!pending || configOptionChangeBlocked(thread, option.id)) return;
    if (thread.identity === "draft" && pendingPreparationRead(thread)) return;
    if (
      option.type === "select" &&
      !option.options.some((item) => item.value === pending.value)
    )
      return;
    setSaving(true);
    setFailed(false);
    try {
      await threads.setConfig(thread.key, option.id, pending.value);
      setSelection(null);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="conversation-option">
      <div className="so-row">
        <span className="so-name">{label}</span>
        {option.type === "select" && option.options.length > 0 ? (
          <ModelPicker
            option={{ ...option, currentValue: proposed }}
            label={label}
            disabled={disabled}
            onPick={choose}
          />
        ) : option.type === "boolean" ? (
          <button
            type="button"
            role="switch"
            aria-label={label}
            aria-checked={on}
            className={`so-toggle${on ? " on" : ""}`}
            disabled={disabled}
            onClick={() => choose(!on)}
          />
        ) : (
          <span className="so-value">{configValueLabel(option)}</span>
        )}
      </div>
      <p className="conversation-option-description">{description}</p>
      <details className="conversation-option-details">
        <summary>{R.optionDetails}</summary>
        <p>{R.optionScope}</p>
        <p>{recorded ? R.optionTiming : R.optionTimingTransient}</p>
      </details>
      {!known && <p className="conversation-option-note">{R.optionReadOnly}</p>}
      {disabled && !saving && (
        <p className="conversation-option-note">{R.optionLocked}</p>
      )}
      {pending && (
        <div className="conversation-option-review">
          <dl>
            <dt>{R.currentValue}</dt>
            <dd>{configValueLabel(option)}</dd>
            <dt>{R.selectedValue}</dt>
            <dd>{configValueLabel({ ...option, currentValue: proposed })}</dd>
          </dl>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving}
              onClick={() => setSelection(null)}
            >
              {R.optionCancel}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={disabled}
              onClick={() => void change()}
            >
              {saving
                ? R.optionChanging
                : recorded
                  ? R.optionChange
                  : R.optionApply}
            </button>
          </div>
        </div>
      )}
      {failed && <p role="alert">{R.optionSaveError}</p>}
    </section>
  );
}

export function sessionOptions(thread: ThreadState, composer = false) {
  // The model option has its own row in the panel;
  // everything else is listed here.
  const modelId = modelConfigOption(thread.configOptions)?.id;
  const reasoningId = thread.configOptions.find(isReasoningOption)?.id;
  return thread.configOptions.filter(
    (o) =>
      o.id !== modelId &&
      o.id !== thread.permissionConfigId &&
      !(composer && o.id === reasoningId),
  );
}

export function SessionOptionsList({
  thread,
  composer = false,
}: {
  thread: ThreadState;
  composer?: boolean;
}) {
  const rest = sessionOptions(thread, composer);
  return (
    <>
      {rest.map((option) => (
        <OptionRow key={option.id} thread={thread} option={option} />
      ))}
    </>
  );
}
