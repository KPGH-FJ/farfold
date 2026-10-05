import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ServiceModelPicker } from "./ServiceModelPicker";
import type { Credential } from "../runtime/credentials";

const record: Credential = {
  id: "service",
  label: "Saved service",
  provider: "Provider",
  endpoint: "https://example.test/v1",
  apiType: "responses",
  models: ["model-one", "model-two"],
  revision: "current",
  complete: true,
  deleting: false,
  grants: [],
};
function render(
  options: Partial<ComponentProps<typeof ServiceModelPicker>> = {},
) {
  const props: ComponentProps<typeof ServiceModelPicker> = {
    value: { id: record.id, revision: record.revision, model: "" },
    items: [record],
    capability: {
      apiTypes: ["responses"],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: null,
    },
    error: false,
    onChange: vi.fn(),
    onRetry: vi.fn(),
    ...options,
  };
  let tree: ReactNode;
  function Capture() {
    tree = ServiceModelPicker(props);
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  let select: ReactElement<ComponentProps<"select">> | undefined;
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "select") select = child as typeof select;
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return { html, select, props };
}

it("waits for an explicit model choice in the selected service", () => {
  const view = render();
  expect(view.select!.props.value).toBe("");
  expect(view.select!.props.disabled).toBe(false);
  expect(view.props.onChange).not.toHaveBeenCalled();
  expect(view.html).toContain("选择一个模型");
  view.select!.props.onChange!({ target: { value: "model-two" } } as never);
  expect(view.props.onChange).toHaveBeenCalledExactlyOnceWith({
    id: record.id,
    revision: record.revision,
    model: "model-two",
  });
});

it("rejects another service's model and cannot silently clear a choice", () => {
  const view = render();
  for (const model of ["unrelated-model", ""])
    view.select!.props.onChange!({ target: { value: model } } as never);
  expect(view.props.onChange).not.toHaveBeenCalled();
});

it("preserves an unavailable model without selecting a replacement", () => {
  const value = { id: record.id, revision: record.revision, model: "removed" };
  const view = render({ value });
  expect(view.select!.props.value).not.toBe("model-one");
  expect(view.html).toContain("原模型暂不可用");
  expect(view.props.onChange).not.toHaveBeenCalled();
  expect(value.model).toBe("removed");
});

it.each([
  { value: { id: record.id, revision: "old", model: "model-one" } },
  { items: [] },
  { items: [{ ...record, deleting: true }] },
  { items: [{ ...record, complete: false }] },
  { error: true },
  { capability: null },
  { disabled: true },
])(
  "blocks unconfirmed service model changes without dropping the original selection %#",
  (options) => {
    const view = render(options);
    expect(view.select!.props.disabled).toBe(true);
    view.select!.props.onChange!({ target: { value: "model-two" } } as never);
    expect(view.props.onChange).not.toHaveBeenCalled();
  },
);

it("hides model API controls when the Agent explicitly does not support them", () => {
  const view = render({
    capability: {
      apiTypes: [],
      validatedApiTypes: [],
      selectionScope: "connection",
      unavailableReason: "No configured service route",
    },
  });
  expect(view.html).toBe("");
  expect(view.select).toBeUndefined();
  expect(view.props.onChange).not.toHaveBeenCalled();
});
