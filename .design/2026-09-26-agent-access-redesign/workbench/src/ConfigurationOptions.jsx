import React, { useId } from "react";
import {
  optionChoices,
  optionEditable,
  optionLabel,
  optionValue,
} from "./additional-configuration.js";
import "./configuration-options.css";

export default function ConfigurationOptions({
  options = [],
  values = {},
  savedValues = values,
  onChange,
  disabled = false,
}) {
  const prefix = useId();
  if (!options.length)
    return <p className="cr-context">当前来源尚未提供其他配置项。</p>;
  return (
    <section className="configuration-options" aria-label="更多配置项">
      <div className="configuration-options-heading">
        <h3>更多配置项</h3>
        <span>按已提供的信息展示</span>
      </div>
      {options.map((option) => {
        const editable = optionEditable(option);
        const descriptionId = `${prefix}-${option.id}-description`;
        const choiceId = `${prefix}-${option.id}-choice`;
        return (
          <article className="configuration-option" key={option.id}>
            <div className="configuration-option-title">
              {editable ? (
                <label htmlFor={choiceId}>{option.label}</label>
              ) : (
                <h4>{option.label}</h4>
              )}
              <span>
                {option.evidence === "interactive-sample"
                  ? "交互样例"
                  : option.evidence === "observed-current-value"
                    ? "审查样例"
                    : "已声明选项"}
              </span>
            </div>
            <p id={descriptionId}>
              {option.description ||
                "用途说明尚未提供；不据名称推断行为、速度或费用。"}
            </p>
            <dl>
              <div>
                <dt>当前值</dt>
                <dd>{optionLabel(option, savedValues)}</dd>
              </div>
              <div>
                <dt>作用对象</dt>
                <dd>{option.scope || "尚未提供"}</dd>
              </div>
              <div>
                <dt>生效时点</dt>
                <dd>{option.effectiveAt || "尚未提供"}</dd>
              </div>
            </dl>
            {editable ? (
              <select
                id={choiceId}
                aria-describedby={descriptionId}
                disabled={disabled}
                value={optionValue(option, values) ?? ""}
                onChange={(event) =>
                  onChange?.({ ...values, [option.id]: event.target.value })
                }
              >
                {!optionChoices(option).some(
                  (item) => item.value === optionValue(option, values),
                ) && (
                  <option value={optionValue(option, values) ?? ""}>
                    {optionLabel(option, values)}（当前值）
                  </option>
                )}
                {optionChoices(option).map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="configuration-option-readonly">
                仅查看 ·{" "}
                {option.type !== "select"
                  ? "此配置类型尚未支持编辑"
                  : option.changeSupported !== true
                    ? "尚未确认可更改的选项"
                    : "目前只提供一个选项"}
              </p>
            )}
            <details>
              <summary>信息依据</summary>
              <p>
                {option.evidence === "interactive-sample"
                  ? "专为本原型设置的交互数据，用于检查成功、失败、结果未知与旧值保护，不是 Agent 能力声明。"
                  : option.evidence === "observed-current-value"
                    ? "来自既有 UI 审查中显示的名称和当前值。这里只复现审查样例；完整选项、实际含义、作用范围和生效方式仍未核实。"
                    : option.evidenceDescription ||
                      "只按提供的配置声明显示，未提供的说明保持未知。"}
              </p>
            </details>
          </article>
        );
      })}
    </section>
  );
}
