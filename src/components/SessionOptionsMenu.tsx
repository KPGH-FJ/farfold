/**
 * 会话选项列表：渲染 Agent 声明的全部 configOptions——select 用分组
 * 下拉（复用 ModelPicker），boolean 用开关，未知类型只读。模型选项仍
 * 遵守创建时锁定：已建立会话中只读。一个组件覆盖所有 Agent，差异只
 * 来自 configOptions 数据本身。
 */
import { ModelPicker } from "./ModelPicker";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import { isReasoningOption } from "./ReasoningControl";
import { fixedConfigOption } from "../runtime/protected_config";
import { STRINGS } from "../runtime/strings";
import {
  configValueLabel,
  modelConfigOption,
  threads,
  type ConfigOptionView,
  type ThreadState,
} from "../runtime/sessions";

/** Translate a declared common category, never an Agent's arbitrary option name. */
function optionLabel(option: ConfigOptionView) {
  return option.category === "mode" ||
    (!option.category && option.id === "mode")
    ? STRINGS.options.modeName
    : option.name;
}

function OptionRow({
  thread,
  option,
}: {
  thread: ThreadState;
  option: ConfigOptionView;
}) {
  const disabled =
    fixedConfigOption(thread, option.id) ||
    thread.configuring ||
    thread.running ||
    thread.submitting ||
    (thread.modelDrift &&
      !(
        thread.configCheck?.status === "confirmation_required" &&
        option.category === "thought_level"
      ));
  const change = (value: unknown) => {
    if (fixedConfigOption(thread, option.id)) return;
    if (thread.identity === "draft" && pendingPreparationRead(thread)) return;
    void threads.setConfig(thread.key, option.id, value).catch(() => undefined);
  };
  if (option.type === "select" && option.options.length > 0) {
    return (
      <div className="so-row">
        <span className="so-name" title={option.description ?? option.id}>
          {optionLabel(option)}
        </span>
        <ModelPicker option={option} disabled={disabled} onPick={change} />
      </div>
    );
  }
  if (option.type === "boolean") {
    const on = option.currentValue === true || option.currentValue === "true";
    return (
      <div className="so-row">
        <span className="so-name" title={option.description ?? option.id}>
          {optionLabel(option)}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className={`so-toggle${on ? " on" : ""}`}
          disabled={disabled}
          onClick={() => change(!on)}
        />
      </div>
    );
  }
  return (
    <div className="so-row">
      <span className="so-name" title={option.description ?? option.id}>
        {optionLabel(option)}
      </span>
      <span className="so-value">{configValueLabel(option)}</span>
    </div>
  );
}

export function SessionOptionsList({
  thread,
  composer = false,
}: {
  thread: ThreadState;
  composer?: boolean;
}) {
  // The model option has its own row in the panel (draft-only editable);
  // everything else is listed here.
  const modelId = modelConfigOption(thread.configOptions)?.id;
  const reasoningId = thread.configOptions.find(isReasoningOption)?.id;
  const rest = thread.configOptions.filter(
    (o) =>
      o.id !== modelId &&
      o.id !== thread.permissionConfigId &&
      !(composer && o.id === reasoningId),
  );
  return (
    <>
      {rest.map((option) => (
        <OptionRow key={option.id} thread={thread} option={option} />
      ))}
    </>
  );
}
