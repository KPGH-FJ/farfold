import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  AgentConnectionPicker,
  type ConnectionOption,
} from "./AgentConnectionPicker";

const options: ConnectionOption[] = [
  {
    id: JSON.stringify(["method", "account"]),
    title: "Account",
    description: "Account authorization.",
  },
  {
    id: JSON.stringify(["method", "terminal"]),
    title: "终端设置",
    description: "Terminal setup.",
  },
  {
    id: JSON.stringify(["api"]),
    title: "模型 API 服务",
    description: "Configured model service.",
  },
];
function render(
  choices = options,
  disabled = false,
  value: string | null = null,
) {
  const onChange = vi.fn();
  const tree = AgentConnectionPicker({
    name: "connection",
    options: choices,
    value,
    disabled,
    onChange,
  });
  const inputs: ReactElement<{
    value: string;
    checked: boolean;
    disabled: boolean;
    onChange: () => void;
  }>[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "input") inputs.push(child as (typeof inputs)[number]);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return { inputs, onChange, html: renderToStaticMarkup(tree) };
}

it.each([1, 2, 3])(
  "shows exactly %i declared radio choices and selecting only records a choice",
  (count) => {
    const view = render(options.slice(0, count));
    expect(view.inputs).toHaveLength(count);
    expect(view.inputs.map((input) => input.props.checked)).toEqual(
      Array(count).fill(false),
    );
    expect(view.html).not.toContain("<button");
    expect(view.onChange).not.toHaveBeenCalled();
    view.inputs.at(-1)!.props.onChange();
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith(
      options[count - 1].id,
    );
  },
);

it("preserves one explicit choice and rejects disabled options and disabled lists", () => {
  const choices = [options[0], { ...options[1], disabled: true }];
  const view = render(choices, false, options[0].id);
  expect(view.inputs.map((input) => input.props.checked)).toEqual([
    true,
    false,
  ]);
  view.inputs[1].props.onChange();
  expect(view.onChange).not.toHaveBeenCalled();
  const locked = render(options, true, options[0].id);
  for (const input of locked.inputs) {
    expect(input.props.disabled).toBe(true);
    input.props.onChange();
  }
  expect(locked.onChange).not.toHaveBeenCalled();
});
