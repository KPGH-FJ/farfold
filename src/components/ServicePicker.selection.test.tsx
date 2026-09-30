import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ComponentProps,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ effects: [] as (() => void)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void) => h.effects.push(effect),
}));
import { ServicePicker } from "./ServicePicker";
import type { Credential } from "../runtime/credentials";

const record: Credential = {
  id: "saved",
  label: "Selected service",
  provider: "",
  endpoint: "https://example.test",
  apiType: "responses",
  models: ["model"],
  revision: "new-revision",
  complete: true,
  deleting: false,
  grants: [],
};
beforeEach(() => {
  h.effects = [];
});
function render(
  value: ComponentProps<typeof ServicePicker>["value"],
  onChange = vi.fn(),
  items = [record],
) {
  let tree: ReactNode;
  function Capture() {
    tree = ServicePicker({
      agentId: "example",
      value,
      onChange,
      data: {
        items,
        error: false,
        onRetry() {},
        capability: {
          apiTypes: ["responses"],
          validatedApiTypes: [],
          selectionScope: "draft",
          unavailableReason: null,
        },
      },
    });
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
  for (const effect of h.effects.splice(0)) effect();
  return { html, select: select!, onChange };
}
it("keeps a saved old revision unselected until the user explicitly chooses the replacement", () => {
  const value = { id: "saved", model: "model", revision: "old-revision" };
  const view = render(value);
  expect(view.onChange).not.toHaveBeenCalled();
  expect(view.html).toContain("配置已改变，请重新选择");
  expect(view.select.props.value).not.toBe(JSON.stringify(["saved", "model"]));
  view.select.props.onChange!({
    target: { value: JSON.stringify(["saved", "model"]) },
  } as never);
  expect(view.onChange).toHaveBeenCalledExactlyOnceWith({
    id: "saved",
    model: "model",
    revision: "new-revision",
  });
  expect(value.revision).toBe("old-revision");
});
it("does not substitute or clear a deleted service when the list refreshes", () => {
  const view = render({ id: "missing", model: "model", revision: "original" });
  expect(view.onChange).not.toHaveBeenCalled();
  expect(view.select.props.value).not.toBe("");
  expect(view.html).toContain("不可用");
});
it("keeps the explicitly selected current revision without calling the parent", () => {
  const view = render({
    id: "saved",
    model: "model",
    revision: record.revision,
  });
  expect(view.select.props.value).toBe(JSON.stringify(["saved", "model"]));
  expect(view.onChange).not.toHaveBeenCalled();
  expect(view.html).not.toContain("配置已改变，请重新选择");
});
