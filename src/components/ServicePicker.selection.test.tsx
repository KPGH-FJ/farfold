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
import { AgentServiceSection } from "./AgentServiceSection";
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
  options: Partial<ComponentProps<typeof ServicePicker>> = {},
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
      ...options,
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

it("selects only a service identity and never substitutes its first model", () => {
  const onChange = vi.fn();
  const view = render(null, onChange, [record], { mode: "service" });
  expect(view.select.props.value).toBe("");
  expect(onChange).not.toHaveBeenCalled();
  expect(view.html).toContain(record.label);
  expect(view.html).not.toContain("<optgroup");
  view.select.props.onChange!({
    target: { value: JSON.stringify(["service", record.id, record.revision]) },
  } as never);
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    id: record.id,
    revision: record.revision,
    model: "",
  });
});

it("keeps service identity selected while its model is still undecided", () => {
  const view = render(
    { id: record.id, revision: record.revision, model: "" },
    vi.fn(),
    [record],
    { mode: "service" },
  );
  expect(view.select.props.value).toBe(
    JSON.stringify(["service", record.id, record.revision]),
  );
  expect(view.onChange).not.toHaveBeenCalled();
});

it("requires explicit re-selection of a changed service identity before choosing its models", () => {
  const value = { id: record.id, revision: "old", model: "" };
  const view = render(value, vi.fn(), [record], { mode: "service" });
  expect(view.select.props.value).not.toBe(
    JSON.stringify(["service", record.id, record.revision]),
  );
  expect(view.html).toContain("配置已改变，请重新选择");
  expect(view.onChange).not.toHaveBeenCalled();
});

it.each(["service", "model"] as const)(
  "locks %s choices when list reading fails despite an old compatible record",
  (mode) => {
    const data = {
      items: [record],
      error: true,
      onRetry: vi.fn(),
      capability: {
        apiTypes: ["responses"],
        validatedApiTypes: [],
        selectionScope: "connection",
        unavailableReason: null,
      },
    };
    const view = render(null, vi.fn(), [record], { mode, data });
    expect(view.select.props.disabled).toBe(true);
    view.select.props.onChange!({
      target: {
        value:
          mode === "service"
            ? JSON.stringify(["service", record.id, record.revision])
            : JSON.stringify([record.id, "model"]),
      },
    } as never);
    view.select.props.onChange!({ target: { value: "" } } as never);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.html).toContain("读取");
  },
);

it("rejects deleting, incomplete and unsupported service identities", () => {
  const invalid = [
    { ...record, id: "deleting", deleting: true },
    { ...record, id: "incomplete", complete: false },
    { ...record, id: "format", apiType: "messages" },
    { ...record, id: "no-models", models: [] },
    { ...record, id: "no-revision", revision: "" },
  ];
  const view = render(null, vi.fn(), invalid, { mode: "service" });
  for (const item of invalid)
    view.select.props.onChange!({
      target: { value: JSON.stringify(["service", item.id, item.revision]) },
    } as never);
  expect(view.onChange).not.toHaveBeenCalled();
  expect(view.html).not.toContain(record.label);
});

it("summarizes a selected service without claiming authentication or repeating its picker", () => {
  const html = renderToStaticMarkup(
    <AgentServiceSection
      agentId="example"
      capability={{
        apiTypes: ["responses"],
        validatedApiTypes: [],
        selectionScope: "connection",
        unavailableReason: null,
      }}
      error={false}
      items={[record]}
      value={{ id: record.id, revision: record.revision, model: "" }}
      onChange={vi.fn()}
      onRetry={vi.fn()}
      onOpenApi={vi.fn()}
      onChangeService={vi.fn()}
      onEditService={vi.fn()}
      onChangeMethod={vi.fn()}
      editing={false}
      disabled={false}
      readonly={false}
    />,
  );
  expect(html).not.toContain("<h3");
  expect(html).toContain(`<strong>${record.label}</strong>`);
  expect(html).toContain("服务已选择");
  expect(html).toContain(record.label);
  expect(html).toContain("<details");
  expect(html).toContain("更换服务");
  expect(html).toContain("编辑服务");
  expect(html).toContain("更换接入方式");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("已登录");
  expect(html).not.toContain("认证成功");
});

function renderApi(
  overrides: Partial<ComponentProps<typeof AgentServiceSection>> = {},
) {
  const onOpenApi = vi.fn(),
    onChange = vi.fn(),
    onRetry = vi.fn();
  let tree: ReactNode;
  function Capture() {
    tree = AgentServiceSection({
      agentId: "example",
      capability: {
        apiTypes: ["responses"],
        validatedApiTypes: [],
        selectionScope: "connection",
        unavailableReason: null,
      },
      error: false,
      items: [],
      value: null,
      onChange,
      onRetry,
      onOpenApi,
      disabled: false,
      readonly: false,
      ...overrides,
    });
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  const buttons: ReactElement<ComponentProps<"button">>[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "button")
        buttons.push(child as (typeof buttons)[number]);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return { html, buttons, onOpenApi, onChange, onRetry };
}

it.each([{ items: [] }, { items: [{ ...record, complete: false }] }])(
  "uses one add-service action when no usable service remains",
  ({ items }) => {
    const view = renderApi({ items });
    expect(view.html).toContain("尚无可用服务");
    expect(view.html).not.toContain("<select");
    expect(view.buttons).toHaveLength(1);
    expect(view.buttons[0].props).toMatchObject({
      className: "btn btn-primary",
      children: "添加模型 API 服务",
      disabled: false,
    });
    view.buttons[0].props.onClick!({} as never);
    expect(view.onOpenApi).toHaveBeenCalledOnce();
    expect(view.onChange).not.toHaveBeenCalled();
  },
);

it("retains the service picker when a usable service exists", () => {
  const view = renderApi({ items: [record] });
  expect(view.html).toContain("<select");
  expect(view.html).not.toContain("尚无可用服务");
  expect(view.html).not.toContain("添加模型 API 服务");
  expect(view.buttons[0].props.className).toBe("btn btn-ghost");
  expect(view.onOpenApi).not.toHaveBeenCalled();
  expect(view.onChange).not.toHaveBeenCalled();
});

it.each(["error", "unknown"])(
  "does not present %s lookup as an empty service list",
  (state) => {
    const view = renderApi(
      state === "error" ? { error: true } : { capability: null },
    );
    expect(view.html).not.toContain("尚无可用服务");
    expect(view.html).not.toContain("添加模型 API 服务");
    expect(view.html).not.toContain("<select");
    if (state === "error") {
      expect(view.html).toContain('role="alert"');
      expect(view.buttons).toHaveLength(1);
      view.buttons[0].props.onClick!({} as never);
      expect(view.onRetry).toHaveBeenCalledOnce();
    } else {
      expect(view.html).toContain('role="status"');
      expect(view.buttons).toHaveLength(0);
    }
    expect(view.onOpenApi).not.toHaveBeenCalled();
  },
);

it("keeps the empty-state add action blocked while work is pending", () => {
  const view = renderApi({ disabled: true });
  expect(view.buttons[0].props.disabled).toBe(true);
  view.buttons[0].props.onClick!({} as never);
  expect(view.onOpenApi).not.toHaveBeenCalled();
});
