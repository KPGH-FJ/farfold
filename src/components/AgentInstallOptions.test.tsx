import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[] }[],
  pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useRef: (current: unknown) => {
    const index = h.cursor++;
    return (h.slots[index] ??= { current });
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = h.cursor++,
      previous = h.effects[index];
    if (
      !previous ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      h.effects[index] = { deps };
      h.pending.push(effect);
    }
  },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import {
  AgentInstallOptions,
  useInstallationReview,
} from "./AgentInstallOptions";
import type { AgentSetupProgress } from "./AgentSetup";
import type { InstallationOptions } from "../runtime/installation_input";
import { INSTALLATION_INPUT_STRINGS as S } from "../runtime/installation_strings";
const options: InstallationOptions = {
  declarationId: "public-model-v1",
  registryVersion: "1.0.0",
  launch: { kind: "uvx", package: "fixture==1.0.0", args: ["-x"] },
  fields: [
    {
      id: "model",
      label: "启动模型",
      argument: "--model",
      valueKind: "model",
      required: false,
      sourceUrl: "https://example.com/model",
    },
  ],
};
type Element = ReactElement<Record<string, unknown>>;
let progress: AgentSetupProgress;
let review: ReturnType<typeof useInstallationReview>;
const changed = vi.fn((next: AgentSetupProgress) => {
  progress = next;
});
function elements(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((node) =>
    isValidElement<Record<string, unknown>>(node)
      ? [node, ...elements(node.props.children as ReactNode)]
      : [],
  );
}
function render(disabled = false) {
  h.cursor = 0;
  review = useInstallationReview(progress, changed);
  const nodes = elements(
    AgentInstallOptions({ ...review.fieldProps, disabled }),
  );
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
function load(current = options) {
  render();
  review.onInfoChange({
    dependencies: [],
    links: [],
    installationOptions: current,
  });
  render();
  return render();
}
function input(nodes = render()) {
  return nodes.find((node) => node.type === "input")!;
}
function edit(value: string) {
  (input().props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  changed.mockClear();
  progress = {
    step: 0,
    choice: "existing",
    selection: {
      service: null,
      config: { model: "original", thought_level: "off" },
    },
  };
});

it("shows inherited settings without inventing a model or changing progress", () => {
  const nodes = load();
  expect(input(nodes).props.value).toBe("");
  expect(nodes.some((node) => node.props.children === S.inheritedPreview)).toBe(
    true,
  );
  expect(review.read()?.values).toEqual({});
  expect(changed).not.toHaveBeenCalled();
});

it("shows the public catalog default without entering it as a user override", () => {
  const nodes = load({
    ...options,
    fields: [{ ...options.fields[0], catalogDefaultValue: "catalog-model" }],
  });
  expect(
    nodes.some(
      (node) =>
        node.type === "p" &&
        typeof node.props.children === "string" &&
        node.props.children.includes("catalog-model"),
    ),
  ).toBe(true);
  expect(input(nodes).props.value).toBe("");
  expect(review.read()?.values).toEqual({});
  expect(changed).not.toHaveBeenCalled();
  edit("provider:chosen");
  expect(review.read()?.values).toEqual({ model: "provider:chosen" });
  expect(progress.selection?.config).toEqual({
    model: "original",
    thought_level: "off",
  });
});

it("retains the same user input after leaving and returning while preserving draft choices", () => {
  load();
  edit("$system.chosen");
  const snapshot = review.read();
  expect(snapshot?.values).toEqual({ model: "$system.chosen" });
  expect(progress.selection?.config).toEqual({
    model: "original",
    thought_level: "off",
  });
  h.slots = [];
  h.effects = [];
  h.pending = [];
  const nodes = load();
  expect(input(nodes).props.value).toBe("$system.chosen");
  expect(review.read()).toEqual(snapshot);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("reviews the existing model on reinstall and makes explicit omission visible", () => {
  load({ ...options, currentValues: { model: "$system.previous" } });
  expect(input().props.value).toBe("$system.previous");
  expect(review.read()?.values).toEqual({ model: "$system.previous" });
  expect(changed).not.toHaveBeenCalled();
  edit("");
  expect(review.read()?.values).toEqual({});
  expect(
    render().some((node) => node.props.children === S.inheritedPreview),
  ).toBe(true);
  expect(progress.installationInput?.values).toEqual({ model: "" });
});

it("blocks old install handlers while invalid edits stay local and absent from progress", () => {
  load();
  edit("provider:model");
  render();
  const readBeforeEdit = review.read;
  changed.mockClear();
  edit("sk-test-secret");
  expect(readBeforeEdit()).toBeNull();
  const nodes = render();
  expect(input(nodes).props.value).toBe("sk-test-secret");
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" && node.props.children === S.invalid,
    ),
  ).toBe(true);
  expect(nodes.some((node) => node.type === "pre")).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(progress.installationInput?.values).toEqual({
    model: "provider:model",
  });
  edit("provider:corrected");
  expect(review.read()?.values).toEqual({ model: "provider:corrected" });
});

it("keeps stale values for review and requires a new explicit choice after declaration changes", () => {
  load();
  edit("provider:original");
  render();
  review.onInfoChange({
    dependencies: [],
    links: [],
    installationOptions: { ...options, registryVersion: "2.0.0" },
  });
  const nodes = render();
  expect(review.read()).toBeNull();
  expect(progress.installationInput?.values.model).toBe("provider:original");
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" && node.props.children === S.changed,
    ),
  ).toBe(true);
  const useExisting = nodes.find(
    (node) => node.type === "button" && node.props.children === S.useExisting,
  )!;
  (useExisting.props.onClick as () => void)();
  expect(review.read()?.values).toEqual({});
  expect(review.read()?.registryVersion).toBe("2.0.0");
});

it.each(["inherit", "replace"])(
  "requires a fresh %s choice when only the declaration identity changes",
  (choice) => {
    load();
    edit("provider:original");
    render();
    const previous = structuredClone(progress.installationInput);
    changed.mockClear();
    review.onInfoChange({
      dependencies: [],
      links: [],
      installationOptions: { ...options, declarationId: "public-model-v2" },
    });
    const nodes = render();
    expect(review.read()).toBeNull();
    expect(progress.installationInput).toEqual(previous);
    expect(changed).not.toHaveBeenCalled();
    expect(nodes.some((node) => node.props.children === S.changed)).toBe(true);
    if (choice === "inherit") {
      const button = nodes.find(
        (node) =>
          node.type === "button" && node.props.children === S.useExisting,
      )!;
      (button.props.onClick as () => void)();
    } else edit("provider:replacement");
    expect(review.read()).toEqual({
      declarationId: "public-model-v2",
      registryVersion: options.registryVersion,
      launch: options.launch,
      values: choice === "inherit" ? {} : { model: "provider:replacement" },
    });
  },
);

it("does not reinterpret rejected stored data as omission", () => {
  progress.installationInputInvalid = true;
  const nodes = load();
  expect(review.read()).toBeNull();
  expect(nodes.some((node) => node.props.children === S.savedInvalid)).toBe(
    true,
  );
  edit("provider:replacement");
  expect(review.read()?.values).toEqual({ model: "provider:replacement" });
  expect(progress.installationInputInvalid).toBeUndefined();
});

it("does not treat pending or failed declaration reads as deletion of the saved input", () => {
  load();
  edit("provider:original");
  render();
  changed.mockClear();
  review.onInfoChange(null);
  for (let pass = 0; pass < 2; pass++) {
    const nodes = render();
    expect(review.read()).toBeNull();
    expect(nodes.some((node) => node.props.children === S.changed)).toBe(false);
    expect(nodes.some((node) => node.props.children === S.useExisting)).toBe(
      false,
    );
    expect(progress.installationInput?.values.model).toBe("provider:original");
    expect(changed).not.toHaveBeenCalled();
  }
  review.onInfoChange({ dependencies: [], links: [] });
  const nodes = render();
  expect(nodes.some((node) => node.props.children === S.changed)).toBe(true);
  expect(progress.installationInput?.values.model).toBe("provider:original");
});
