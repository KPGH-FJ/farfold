/**
 * 会话选项列表：渲染 Agent 声明的全部 configOptions——select 用分组
 * 下拉（复用 ModelPicker），boolean 用开关，未知类型只读。模型选项仍
 * 只在本轮工作结束、真实声明与恢复核对允许时修改。一个组件覆盖所有 Agent，差异只
 * 来自 configOptions 数据本身。
 */
import { ModelPicker } from "./ModelPicker";
import { pendingPreparationRead } from "../runtime/agent_preparation";
import { isReasoningOption } from "./ReasoningControl";
import { configOptionChangeBlocked } from "../runtime/protected_config";
import { useAuthenticationActivity } from "../runtime/authentication";
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
  useAuthenticationActivity(thread.agentId);
  const disabled = configOptionChangeBlocked(thread, option.id);
  const change = (value: unknown) => {
    if (configOptionChangeBlocked(thread, option.id)) return;
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
