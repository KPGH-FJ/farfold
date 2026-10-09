import { expect, it } from "vitest";
import { configValueLabel, normalizeConfigOptions } from "./session_projection";

it.each([
  [true, "开启"],
  [false, "关闭"],
])("shows a confirmed boolean value %s", (value, label) => {
  const option = normalizeConfigOptions([
    { id: "feature", name: "Feature", type: "boolean", currentValue: value },
  ])[0];
  expect(configValueLabel(option)).toBe(label);
});
