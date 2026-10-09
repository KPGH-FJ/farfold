import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionOptionsList } from "./SessionOptionsMenu";
import { ModelPicker } from "./ModelPicker";
import {
  freshThreadState,
  threads,
  type ThreadState,
  type ConfigOptionView,
} from "../runtime/sessions";

// rows() invokes OptionRow directly to inspect its callbacks. Read the real
// authentication snapshot without requiring a mounted React dispatcher here.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => [initial, () => {}],
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));

const option = (id: string, category: string): ConfigOptionView => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue: "original",
  options: [
    { value: "original", name: "Original" },
    { value: "changed", name: "Changed" },
  ],
});
function thread() {
  const s = freshThreadState(
    "options-categories",
    "example",
    "/original",
    "draft",
  );
  s.configOptions = [
    option("model", "model"),
    option("inference_speed", "model"),
    option("reasoning_effort", "thought_level"),
    option("thinking_budget", "thought_level"),
  ];
  return s;
}
type Element = ReactElement<Record<string, unknown>>;
function rows(s: ThreadState) {
  const root = SessionOptionsList({ thread: s, composer: true });
  const children = Children.toArray(root.props.children);
  return children.filter(isValidElement).map((child) => {
    const element = child as Element;
    return (element.type as (props: unknown) => ReactNode)(element.props);
  });
}
function controls(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (child.type === ModelPicker) found.push(child);
    found.push(...controls(child.props.children as ReactNode));
  });
  return found;
}
afterEach(() => vi.restoreAllMocks());

it("keeps the secondary reasoning and model options reachable beside the first composer controls", () => {
  const s = thread();
  const html = renderToStaticMarkup(<SessionOptionsList thread={s} composer />);
  expect(html).toContain("thinking_budget");
  expect(html).toContain("inference_speed");
  expect(html).not.toContain("reasoning_effort");
  expect(
    controls(rows(s)).map((o) => (o.props.option as ConfigOptionView).id),
  ).toEqual(["inference_speed", "thinking_budget"]);
});

it.each(["established", "resumed"])(
  "makes every extra protected option read-only for %s conversations",
  (state) => {
    const s = thread();
    if (state === "resumed") s.resumed = true;
    else s.identity = "established";
    const run = vi.spyOn(threads, "setConfig").mockResolvedValue();
    for (const picker of controls(rows(s))) {
      expect(picker.props.disabled).toBe(true);
      (picker.props.onPick as (v: string) => void)("changed");
    }
    expect(run).not.toHaveBeenCalled();
    expect(s.configOptions.map((o) => o.currentValue)).toEqual(
      Array(4).fill("original"),
    );
  },
);

it("keeps a recorded ID read-only after its category changes, while preserving unrelated options", () => {
  const s = thread();
  s.identity = "established";
  s.configOptions = [
    option("recorded-depth", "vendor_feature"),
    option("context", "model_config"),
  ];
  Object.assign(s, {
    configCheck: {
      status: "ready",
      issues: [],
      protectedIds: ["recorded-depth"],
      current: { choices: [] },
    },
  });
  const all = controls(rows(s));
  expect(
    all.find(
      (o) => (o.props.option as ConfigOptionView).id === "recorded-depth",
    )?.props.disabled,
  ).toBe(true);
  expect(
    all.find((o) => (o.props.option as ConfigOptionView).id === "context")
      ?.props.disabled,
  ).toBe(false);
});

it("rechecks the identity of a formerly editable draft before an extra-option callback runs", () => {
  const s = thread();
  const run = vi.spyOn(threads, "setConfig").mockResolvedValue();
  const picker = controls(rows(s)).find(
    (o) => (o.props.option as ConfigOptionView).id === "inference_speed",
  )!;
  expect(picker.props.disabled).toBe(false);
  s.identity = "established";
  (picker.props.onPick as (v: string) => void)("changed");
  expect(run).not.toHaveBeenCalled();
});
