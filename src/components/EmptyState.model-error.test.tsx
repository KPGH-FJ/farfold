import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import type { AgentCardModel } from "../runtime/agents";
import type { ThreadState } from "../runtime/session_types";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  effects: [] as (() => void)[],
  open: vi.fn(),
  setConfig: vi.fn(),
  live: null as ThreadState | null,
  credentials: vi.fn(),
  capabilities: vi.fn(),
}));
vi.mock("react-dom", () => ({
  createPortal: (children: ReactNode) => children,
}));
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
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !deps ||
      !slot.deps ||
      deps.some((v, i) => !Object.is(v, slot.deps?.[i]))
    ) {
      slot.deps = deps;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => ({
    cwd,
    ready: true,
    enabled: () => true,
  }),
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: vi.fn() }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.credentials,
  getServiceCapabilities: h.capabilities,
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: (id: string) => ({
      service: null,
      config: id === "A" ? { model: "kept-choice" } : {},
    }),
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: (key: string) => (key === h.live?.key ? h.live : null),
  threads: {
    open: h.open,
    setConfig: h.setConfig,
    discardDraft: vi.fn(),
    thread: (key: string) => (key === h.live?.key ? h.live : null),
  },
}));
vi.mock(
  "../runtime/worktrees",
  () => import("../runtime/worktree_catalogue.test-fixture"),
);

import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import {
  NewConversationAgentDialog,
  NewConversationModelDialog,
} from "./NewConversationPickers";
import { ErrorNotice } from "./ErrorNotice";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { freshThreadState } from "../runtime/session_projection";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { NEW_CONVERSATION_PICKER_STRINGS as S } from "../runtime/new_conversation_picker_strings";
import { ERROR_STRINGS as E } from "../runtime/error_strings";

type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof EmptyState>;
function walk(tree: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(tree, (node) => {
    if (isValidElement<Record<string, unknown>>(node))
      out.push(
        node,
        ...walk(node.props.children as ReactNode),
        ...walk(node.props.controls as ReactNode),
        ...walk(node.props.footer as ReactNode),
        ...walk(node.props.searchField as ReactNode),
      );
  });
  return out;
}
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((v) =>
      isValidElement<{ children?: ReactNode }>(v)
        ? text(v.props.children)
        : String(v),
    )
    .join("");
}
function render() {
  for (let pass = 0; pass < 10; pass++) {
    h.cursor = 0;
    const root = walk(EmptyState(props));
    const dialog = root.find((n) => n.type === NewConversationModelDialog);
    const popup = dialog
      ? walk(
          NewConversationModelDialog(
            dialog.props as ComponentProps<typeof NewConversationModelDialog>,
          ),
        )
      : [];
    if (!h.effects.length)
      return {
        root,
        dialog,
        popup,
        composer: root.find((n) => n.type === Composer)!,
      };
    for (const effect of h.effects.splice(0)) effect();
  }
  throw new Error("controlled render did not settle");
}
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return render();
}
function button(nodes: Element[], label: string) {
  return nodes.find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  )!;
}
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  h.live = null;
  h.open.mockReset();
  h.setConfig.mockReset();
  h.credentials.mockReset().mockResolvedValue([]);
  h.capabilities
    .mockReset()
    .mockResolvedValue({ apiTypes: [], unavailableReason: null });
  for (const id of ["A", "B"]) allowAutomaticConnection(id);
  Object.assign(newConversationChoice, {
    cwd: "/owned-fixture",
    agentId: "A",
    service: null,
    config: { model: "kept-choice" },
    reviewRequired: false,
  });
  composerDrafts.update("new", () => ({
    text: "Keep this draft",
    attachments: [
      {
        id: "owned-attachment",
        kind: "file",
        uri: "file:///owned-fixture/input.txt",
        name: "input.txt",
        deliveryMode: "location",
      },
    ],
  }));
  props = {
    agents: ["A", "B"].map(
      (id) => ({ id, name: id, status: "connected" }) as AgentCardModel,
    ),
    onGoSettings: vi.fn(),
    onProjectChange: vi.fn(),
    onStarted: vi.fn(),
  };
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
  composerDrafts.clear("new");
  vi.useRealTimers();
});

it("bridges a real preparation rejection into the already open model dialog without retrying, sending or changing the draft choice", async () => {
  let reject!: (error: Error) => void;
  h.open.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const before = composerDrafts.read("new");
  const choice = structuredClone(newConversationChoice.config);
  const trigger = render().root.find(
    (n) => n.props["aria-label"] === W.modelChoice,
  )!;
  (trigger.props.onClick as () => void)();
  render();
  await vi.advanceTimersByTimeAsync(300);
  expect(render().dialog?.props.readingModels).toBe(true);
  expect(h.open).toHaveBeenCalledTimes(1);
  reject(new Error("AGENT_INITIALIZE_TIMEOUT"));
  const failed = await settle();
  expect(failed.composer.props.note).toMatchObject({
    message: expect.stringContaining(E.agentInitializeTimeout),
  });
  expect(failed.dialog?.props.readingModels).toBe(false);
  expect(failed.dialog?.props.readError).toEqual(failed.composer.props.note);
  expect(failed.popup.find((n) => n.type === ErrorNotice)?.props.message).toBe(
    (failed.composer.props.note as { message: string }).message,
  );
  expect(button(failed.popup, S.currentModel).props.disabled).toBe(true);
  expect(
    failed.popup.some(
      (n) =>
        n.props.role === "status" &&
        text(n.props.children as ReactNode) === S.readingModels,
    ),
  ).toBe(false);
  expect(failed.composer.props.disabled).toBe(true);
  expect(failed.composer.props.sendRequest).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  render();
  expect(h.open).toHaveBeenCalledTimes(1);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(newConversationChoice.config).toEqual(choice);
  expect(composerDrafts.read("new")).toBe(before);
  (button(failed.popup, S.prepare).props.onClick as () => void)();
  expect(props.onGoSettings).toHaveBeenCalledTimes(1);
});

it("does not let a rejected old Agent preparation contaminate a newly selected prepared draft", async () => {
  let reject!: (error: Error) => void;
  h.open.mockImplementation((value: { agentId: string }) =>
    value.agentId === "A"
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : Promise.resolve(h.live),
  );
  (
    render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
      .onClick as () => void
  )();
  render();
  await vi.advanceTimersByTimeAsync(300);
  (
    render().root.find((n) => n.props["aria-label"] === W.agentChoice)!.props
      .onClick as () => void
  )();
  const picker = render().root.find(
    (n) => n.type === NewConversationAgentDialog,
  )!;
  h.live = freshThreadState(
    "prepared-b",
    "B",
    "/owned-fixture",
    "synthetic-native-id",
  );
  (picker.props.onPick as (id: string) => void)("B");
  render();
  await vi.advanceTimersByTimeAsync(300);
  await settle();
  (
    render().root.find((n) => n.props["aria-label"] === W.modelChoice)!.props
      .onClick as () => void
  )();
  render();
  reject(new Error("AGENT_INITIALIZE_TIMEOUT"));
  const current = await settle();
  expect(current.composer.props.note).toBeNull();
  expect(current.dialog?.props.readError ?? null).toBeNull();
  expect(current.popup.some((n) => n.type === ErrorNotice)).toBe(false);
  expect(newConversationChoice.agentId).toBe("B");
  expect(h.open).toHaveBeenCalledTimes(2);
  expect(h.setConfig).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep this draft");
});
