/**
 * 会话选项列表：渲染 Agent 声明的全部 configOptions——select 用分组
 * 下拉（复用 ModelPicker），boolean 用开关，未知类型只读。模型选项仍
 * 遵守创建时锁定：已建立会话中只读。一个组件覆盖所有 Agent，差异只
 * 来自 configOptions 数据本身。
 */
import { ModelPicker } from "./ModelPicker";
import {
  configValueLabel,
  modelConfigOption,
  threads,
  type ConfigOptionView,
  type ThreadState,
} from "../runtime/sessions";

function OptionRow({
  thread,
  option,
}: {
  thread: ThreadState;
  option: ConfigOptionView;
}) {
  const disabled =
    thread.configuring ||
    thread.running ||
    thread.submitting ||
    (thread.modelDrift &&
      !(
        thread.configCheck?.status === "confirmation_required" &&
        option.category === "thought_level"
      ));
  const change = (value: unknown) => {
    void threads.setConfig(thread.key, option.id, value).catch(() => undefined);
  };
  if (option.type === "select" && option.options.length > 0) {
    return (
      <div className="so-row">
        <span className="so-name" title={option.description ?? option.id}>
          {option.name}
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
          {option.name}
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
        {option.name}
      </span>
      <span className="so-value">{configValueLabel(option)}</span>
    </div>
  );
}

export function SessionOptionsList({ thread }: { thread: ThreadState }) {
  // The model option has its own row in the panel (draft-only editable);
  // everything else is listed here.
  const modelId = modelConfigOption(thread.configOptions)?.id;
  const rest = thread.configOptions.filter((o) => o.id !== modelId);
  return (
    <>
      {rest.map((option) => (
        <OptionRow key={option.id} thread={thread} option={option} />
      ))}
    </>
  );
}
