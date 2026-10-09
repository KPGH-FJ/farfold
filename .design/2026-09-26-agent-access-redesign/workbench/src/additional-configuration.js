// Prototype metadata only. Observed labels/current values do not establish semantics
// or a complete option set. The interactive sample is intentionally brand-neutral.
export const OBSERVED_CONFIGURATION_SAMPLE = [
  {
    id: "collaboration_mode",
    label: "Collaboration mode",
    type: "select",
    currentValue: "Default",
    options: ["Default"],
    changeSupported: false,
    evidence: "observed-current-value",
  },
  {
    id: "fast_mode",
    label: "Fast mode",
    type: "select",
    currentValue: "Off",
    options: ["Off"],
    changeSupported: false,
    evidence: "observed-current-value",
  },
];
export const INTERACTIVE_CONFIGURATION_SAMPLE = [
  {
    id: "review-detail",
    label: "交互样例选项",
    type: "select",
    currentValue: "standard",
    options: [
      { value: "standard", label: "标准样例" },
      { value: "expanded", label: "扩展样例" },
    ],
    changeSupported: true,
    description: "仅用于体验选项比较和保存结果，不代表任何 Agent 的实际功能。",
    scope: "本条示例对话的配置记录",
    effectiveAt: "本地演示确认并保存后；不会改变真实回答或费用",
    evidence: "interactive-sample",
  },
  {
    id: "review-unsupported",
    label: "未知类型样例",
    type: "unrecognized",
    currentValue: "已提供一个不可编辑的样例值",
    description: "类型尚未支持时保留提供的值，不猜测如何编辑。",
    evidence: "interactive-sample",
  },
];
export function additionalOptions(capability = {}, task = {}) {
  const declared = (capability?.configOptions || []).filter(
    (option) => option?.id && !["model", "effort"].includes(option.id),
  );
  const samples = task.reviewConfigurationOptions
    ? INTERACTIVE_CONFIGURATION_SAMPLE
    : [];
  return [...declared, ...samples].filter(
    (option, index, all) =>
      all.findIndex((item) => item.id === option.id) === index,
  );
}
export function optionChoices(option) {
  return (option.options || [])
    .map((item) =>
      typeof item === "string"
        ? { value: item, label: item }
        : { value: item?.value ?? item?.id, label: item?.label ?? item?.name },
    )
    .filter(
      (item) =>
        typeof item.value === "string" && typeof item.label === "string",
    );
}
export function optionEditable(option) {
  return (
    option.type === "select" &&
    option.changeSupported === true &&
    optionChoices(option).length > 1
  );
}
export function optionValue(option, values = {}) {
  return Object.hasOwn(values || {}, option.id)
    ? values[option.id]
    : option.currentValue;
}
export function optionLabel(option, values = {}) {
  const value = optionValue(option, values);
  const label = optionChoices(option).find(
    (item) => item.value === value,
  )?.label;
  if (label) return label;
  if (value === undefined || value === null || value === "") return "未提供";
  return typeof value === "string" ? value : JSON.stringify(value);
}
export function configurationValuesEqual(left = {}, right = {}) {
  const keys = new Set([
    ...Object.keys(left || {}),
    ...Object.keys(right || {}),
  ]);
  return [...keys].every(
    (key) => JSON.stringify(left?.[key]) === JSON.stringify(right?.[key]),
  );
}
export function validAdditionalValues(options, previous = {}, next = previous) {
  const keys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(next || {}),
  ]);
  return [...keys].every((key) => {
    if (JSON.stringify(previous?.[key]) === JSON.stringify(next?.[key]))
      return true;
    const option = options.find((item) => item.id === key);
    return (
      option &&
      optionEditable(option) &&
      optionChoices(option).some((item) => item.value === next?.[key])
    );
  });
}
