import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Credential } from "../runtime/credentials";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  pending: [] as (() => void)[],
  list: vi.fn(),
  save: vi.fn(),
  release: vi.fn(),
  acquire: vi.fn(),
  start: vi.fn(),
  changed: null as (() => void) | null,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => `key-field-${h.cursor++}`,
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots))
      h.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      h.slots[index],
      (value: unknown) => {
        h.slots[index] =
          typeof value === "function" ? value(h.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.slots)) h.slots[index] = { current: initial };
    return h.slots[index];
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const index = h.cursor++;
    const previous = h.effects[index];
    if (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      const next = { deps } as typeof previous;
      h.effects[index] = next;
      h.pending.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect() || undefined;
      });
    }
  },
}));
vi.mock("../runtime/agents", () => ({ authKeySave: h.save }));
vi.mock("../runtime/credentials", () => ({
  listCredentials: h.list,
  subscribeCredentialChanges: (changed: () => void) => {
    h.changed = changed;
    return () => {
      h.changed = null;
    };
  },
}));

import { MethodApiKeySection, isMethodCredential } from "./MethodApiKeySection";
import { METHOD_API_KEY_STRINGS as S } from "../runtime/method_api_key_strings";
import { STRINGS } from "../runtime/strings";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof MethodApiKeySection>;
const record = (overrides: Partial<Credential> = {}): Credential => ({
  id: "key-ref",
  label: "My login key",
  provider: "declared-provider",
  endpoint: "",
  apiType: "",
  models: [],
  grants: [],
  revision: "saved-revision",
  complete: false,
  deleting: false,
  purpose: "authentication",
  ...overrides,
});
function render() {
  h.cursor = 0;
  const nodes: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      nodes.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(MethodApiKeySection(props));
  for (const effect of h.pending.splice(0)) effect();
  return nodes;
}
async function settled() {
  let nodes: Element[] = [];
  for (let round = 0; round < 5; round++) {
    nodes = render();
    await Promise.resolve();
  }
  return nodes;
}
const button = (nodes: Element[], text: string) =>
  nodes.find((node) => node.type === "button" && node.props.children === text)!;
const click = (node: Element) => (node.props.onClick as () => void)();
function change(node: Element, value: string) {
  (node.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
async function addKey() {
  let nodes = await settled();
  const add = button(nodes, S.add);
  if (add) click(add);
  nodes = render();
  change(
    nodes.find(
      (node) => node.type === "input" && node.props.type === "password",
    )!,
    "LOCAL-KEY-INPUT-CANARY",
  );
  change(
    nodes.find((node) => node.type === "input" && !node.props.type)!,
    "My login key",
  );
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.changed = null;
  vi.clearAllMocks();
  h.list.mockReset().mockResolvedValue([]);
  h.save.mockReset().mockResolvedValue(record());
  h.acquire.mockReset().mockReturnValue(h.release);
  props = {
    agentId: "capability-driven",
    methodId: "key-method",
    provider: "declared-provider",
    cwd: "/original",
    disabled: false,
    onAcquire: h.acquire,
    onStart: h.start,
  };
});
afterEach(() => {
  for (const effect of h.effects) effect?.cleanup?.();
});

it("offers only exact-provider method keys and starts with a current reference and revision", async () => {
  h.list.mockResolvedValue([
    record(),
    record({ id: "other-provider", provider: "Declared-Provider" }),
    record({
      id: "model-service",
      endpoint: "https://service.example",
      apiType: "responses",
      models: ["model"],
    }),
    record({
      id: "legacy-grant",
      grants: [{ agentId: "other", envName: "KEY", overrideExisting: false }],
    }),
    record({ id: "deleting", deleting: true }),
  ]);
  let nodes = await settled();
  expect(
    nodes
      .filter((node) => node.type === "option" && node.props.value)
      .map((node) => node.props.value),
  ).toEqual(["key-ref"]);
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(true);
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  nodes = render();
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(false);
  expect(h.start).not.toHaveBeenCalled();
  click(button(nodes, STRINGS.agents.auth.start));
  expect(h.start).toHaveBeenCalledExactlyOnceWith({
    id: "key-ref",
    revision: "saved-revision",
  });
  expect(h.save).not.toHaveBeenCalled();
  expect(isMethodCredential(record(), "declared-provider")).toBe(true);
});

it("saves a new password input explicitly and never authenticates during storage", async () => {
  await addKey();
  click(button(render(), S.save));
  await settled();
  expect(h.save).toHaveBeenCalledExactlyOnceWith({
    agentId: props.agentId,
    methodId: props.methodId,
    cwd: "/original",
    source: undefined,
    expectedProvider: "declared-provider",
    label: "My login key",
    key: "LOCAL-KEY-INPUT-CANARY",
  });
  expect(h.start).not.toHaveBeenCalled();
  expect(h.release).toHaveBeenCalledOnce();
  let nodes = render();
  expect(nodes.some((node) => node.type === "input")).toBe(false);
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(false);
  click(button(nodes, STRINGS.agents.auth.start));
  expect(h.start).toHaveBeenCalledExactlyOnceWith({
    id: "key-ref",
    revision: "saved-revision",
  });
  click(button(nodes, S.add));
  nodes = render();
  expect(
    nodes.find(
      (node) => node.type === "input" && node.props.type === "password",
    )?.props.value,
  ).toBe("");
});

it("keeps relogin explicit and passes only the selected key reference and revision", async () => {
  h.list.mockResolvedValue([record()]);
  props.startLabel = "重新登录";
  let nodes = await settled();
  expect(button(nodes, "重新登录").props.disabled).toBe(true);
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  nodes = render();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  click(button(nodes, "重新登录"));
  expect(h.start).toHaveBeenCalledExactlyOnceWith({
    id: "key-ref",
    revision: "saved-revision",
  });
  expect(h.save).not.toHaveBeenCalled();
});

it("keeps a failed save retryable without exposing its error or authenticating and clears cancelled input", async () => {
  h.save.mockRejectedValueOnce(new Error("LOCAL-KEY-INPUT-CANARY"));
  await addKey();
  click(button(render(), S.save));
  let nodes = await settled();
  expect(nodes.some((node) => node.props.children === S.failed)).toBe(true);
  expect(
    nodes.some((node) => node.props.children === "LOCAL-KEY-INPUT-CANARY"),
  ).toBe(false);
  expect(h.start).not.toHaveBeenCalled();
  expect(button(nodes, S.save).props.disabled).toBe(false);
  click(button(nodes, STRINGS.access.cancel));
  nodes = render();
  expect(nodes.some((node) => node.type === "input")).toBe(false);
  click(button(nodes, S.add));
  nodes = render();
  expect(
    nodes.find(
      (node) => node.type === "input" && node.props.type === "password",
    )?.props.value,
  ).toBe("");
  change(
    nodes.find(
      (node) => node.type === "input" && node.props.type === "password",
    )!,
    "SECOND-LOCAL-CANARY",
  );
  change(
    nodes.find((node) => node.type === "input" && !node.props.type)!,
    "Retry key",
  );
  click(button(render(), S.save));
  await settled();
  expect(h.save).toHaveBeenCalledTimes(2);
  expect(h.start).not.toHaveBeenCalled();
});

it("requires reselecting a revised saved key instead of adopting it automatically", async () => {
  h.list.mockResolvedValue([record()]);
  let nodes = await settled();
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  h.list.mockResolvedValue([record({ revision: "rotated-revision" })]);
  h.changed!();
  nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(true);
  expect(nodes.some((node) => node.props.children === S.changed)).toBe(true);
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  click(button(render(), STRINGS.agents.auth.start));
  expect(h.start).toHaveBeenCalledExactlyOnceWith({
    id: "key-ref",
    revision: "rotated-revision",
  });
});

it("offers a retry for list failure and retains the source guard", async () => {
  h.list.mockRejectedValueOnce(new Error("unavailable"));
  let nodes = await settled();
  expect(
    nodes.some(
      (node) =>
        node.props.role === "alert" &&
        Children.toArray(node.props.children as ReactNode).includes(
          S.loadFailed,
        ),
    ),
  ).toBe(true);
  h.list.mockResolvedValue([record()]);
  click(button(nodes, STRINGS.service.retry));
  nodes = await settled();
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  props = { ...props, source: "selected-api-service" };
  nodes = await settled();
  expect(button(nodes, STRINGS.agents.auth.start).props.disabled).toBe(true);
  expect(button(nodes, S.add).props.disabled).toBe(true);
  expect(h.start).not.toHaveBeenCalled();
});

it("opens an empty provider key form after reading without a second add click or authentication", async () => {
  const nodes = await settled();
  expect(
    nodes.some(
      (node) => node.type === "input" && node.props.type === "password",
    ),
  ).toBe(true);
  expect(button(nodes, S.add)).toBeUndefined();
  expect(button(nodes, S.save).props.disabled).toBe(true);
  expect(button(nodes, STRINGS.agents.auth.start)).toBeUndefined();
  expect(h.save).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
});

it("hoists one save action to the footer and keeps saving separate from explicit authentication", async () => {
  const primary = vi.fn();
  props.onPrimaryChange = primary;
  await addKey();
  await settled();
  let nodes = render();
  expect(button(nodes, S.save)).toBeUndefined();
  expect(button(nodes, STRINGS.agents.auth.start)).toBeUndefined();
  const save = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(save.label).toBe(S.save);
  expect(save.disabled).toBe(false);
  save.run();
  await settled();
  expect(h.save).toHaveBeenCalledOnce();
  expect(h.start).not.toHaveBeenCalled();
  save.run();
  expect(h.save).toHaveBeenCalledOnce();
  const verify = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(verify.label).toBe(STRINGS.agents.auth.start);
  expect(verify.disabled).toBe(false);
  verify.run();
  expect(h.start).toHaveBeenCalledExactlyOnceWith({
    id: "key-ref",
    revision: "saved-revision",
  });
});

it("rejects a prior footer authentication action after changing the method target", async () => {
  h.list.mockResolvedValue([record()]);
  const primary = vi.fn();
  props.onPrimaryChange = primary;
  let nodes = await settled();
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  await settled();
  const old = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  expect(old.disabled).toBe(false);
  props = { ...props, methodId: "another-method", cwd: "/new-location" };
  await settled();
  old.run();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

it("locks a previously selected key when list refresh fails, including its prior footer callback", async () => {
  h.list.mockResolvedValue([record()]);
  const primary = vi.fn();
  props.onPrimaryChange = primary;
  let nodes = await settled();
  change(
    nodes.find((node) => node.type === "select")!,
    "key-ref",
  );
  await settled();
  const old = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  h.list.mockRejectedValueOnce(new Error("list failed"));
  h.changed!();
  nodes = await settled();
  expect(nodes.find((node) => node.type === "select")?.props.disabled).toBe(
    true,
  );
  expect(
    (
      primary.mock.calls.at(
        -1,
      )![0] as import("../runtime/access_primary").AgentAccessPrimary
    ).disabled,
  ).toBe(true);
  old.run();
  expect(h.start).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
});

it("invalidates a save footer after cancelling the unsaved password form", async () => {
  const primary = vi.fn();
  props.onPrimaryChange = primary;
  await addKey();
  await settled();
  const old = primary.mock.calls.at(
    -1,
  )![0] as import("../runtime/access_primary").AgentAccessPrimary;
  const nodes = render();
  click(button(nodes, STRINGS.access.cancel));
  await settled();
  old.run();
  expect(h.save).not.toHaveBeenCalled();
  expect(h.start).not.toHaveBeenCalled();
  click(button(render(), S.add));
  expect(
    render().find(
      (node) => node.type === "input" && node.props.type === "password",
    )?.props.value,
  ).toBe("");
});
