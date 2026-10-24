import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value: unknown }[],
  invoke: vi.fn().mockResolvedValue(null),
}));

// Keep ThreadView's real selection callback and the actual preparation store.
// Only React mounting and the unrelated browser/native boundaries are stubbed.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useMemo: (read: () => unknown) => read(),
  useContext: () => false,
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/browser_sharing", async (original) => ({
  ...(await original<typeof import("../runtime/browser_sharing")>()),
  useBrowserSharing: () => ({
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: async () => {},
    allow: async () => {},
    stop: async () => {},
    respond: async () => {},
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { ConfigurationChangeReview } from "./ConfigurationChangeReview";
import {
  freshThreadState,
  threads,
  type ThreadState,
} from "../runtime/sessions";
import {
  pendingPreparationRead,
  preparationFor,
} from "../runtime/agent_preparation";
import { configOptionChangeBlocked } from "../runtime/protected_config";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";

type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function view(thread: ThreadState) {
  h.cursor = 0;
  const tree = nodes(
    ThreadView({
      thread,
      active: true,
      agents: [],
      onGoSettings: vi.fn(),
      onOpened: vi.fn(),
    }),
  );
  const composer = tree.find((node) => node.type === Composer)!;
  return {
    composer,
    controls: nodes(composer.props.controls as ReactNode),
  };
}
function seed(name: string, identity: ThreadState["identity"] = "established") {
  const thread = freshThreadState(name, name, "/owned-fixture", "native");
  thread.identity = identity;
  thread.resumed = identity === "established";
  thread.configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "original",
      options: [
        { value: "original", name: "Original" },
        { value: "different", name: "Different" },
      ],
    },
  ];
  thread.configCheck = {
    status: "ready",
    protectedIds: ["model"],
    issues: [],
    current: {
      choices: [
        { id: "model", category: "model", type: "select", value: "original" },
      ],
    },
  };
  preparationFor(thread.agentId).requireExplicitRead(thread);
  expect(pendingPreparationRead(thread)).toBe(true);
  return thread;
}
function noImplicitWork(set: ReturnType<typeof vi.spyOn>) {
  expect(set).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.invoke.mockClear();
});
afterEach(() => vi.restoreAllMocks());

it("keeps an idle confirmed established model change review reachable despite the new-draft preparation read marker", () => {
  const thread = seed("established-model-read-gate");
  const before = structuredClone(thread);
  const set = vi.spyOn(threads, "setConfig").mockResolvedValue(undefined);
  expect(configOptionChangeBlocked(thread, "model")).toBe(false);
  const picker = view(thread).controls.find(
    (node) => node.type === ModelPicker,
  )!;
  expect(picker).toBeDefined();
  expect(picker.props.disabled).toBe(false);
  (picker.props.onPick as (value: string) => void)("different");
  const review = view(thread).controls.find(
    (node) => node.type === ConfigurationChangeReview,
  );
  expect(
    review,
    "the selection must reach review before any setter",
  ).toBeDefined();
  expect(review!.props.value).toBe("different");
  expect(thread).toEqual(before);
  noImplicitWork(set);
});

it("keeps a new draft gated by that same real preparation marker without a model selection or implicit send", async () => {
  const thread = seed("draft-model-read-gate", "draft");
  const before = structuredClone(thread);
  const set = vi.spyOn(threads, "setConfig").mockResolvedValue(undefined);
  const send = vi.spyOn(threads, "send");
  const rendered = view(thread);
  expect(rendered.composer.props.disabled).toBe(true);
  expect(rendered.controls.some((node) => node.type === ModelPicker)).toBe(
    false,
  );
  expect(
    rendered.controls.some((node) => node.type === ConfigurationChangeReview),
  ).toBe(false);
  await expect(
    (rendered.composer.props.onSend as (blocks: unknown[]) => Promise<void>)(
      [],
    ),
  ).rejects.toThrow(C.readRequired);
  expect(thread).toEqual(before);
  expect(send).not.toHaveBeenCalled();
  noImplicitWork(set);
});

it.each(["running", "unknown"] as const)(
  "keeps %s established work blocked even if its model callback is invoked directly",
  (work) => {
    const thread = seed(`blocked-${work}-model-read-gate`);
    if (work === "running") thread.running = true;
    else thread.connectionOutcomeUnknown = true;
    const before = structuredClone(thread);
    const set = vi.spyOn(threads, "setConfig").mockResolvedValue(undefined);
    expect(configOptionChangeBlocked(thread, "model")).toBe(true);
    const picker = view(thread).controls.find(
      (node) => node.type === ModelPicker,
    )!;
    expect(picker.props.disabled).toBe(true);
    (picker.props.onPick as (value: string) => void)("different");
    expect(
      view(thread).controls.some(
        (node) => node.type === ConfigurationChangeReview,
      ),
    ).toBe(false);
    expect(thread).toEqual(before);
    noImplicitWork(set);
  },
);
