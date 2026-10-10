import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Credential } from "../runtime/credentials";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  credentials: vi.fn(),
  open: vi.fn(),
  send: vi.fn(),
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
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
      slot.deps = deps;
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string) => ({ cwd, ready: true, enabled: () => true }),
}));
vi.mock("../runtime/connection_hold", () => ({ useConnectionHold: () => {} }));
vi.mock("../runtime/credentials", async (original) => ({
  ...(await original<typeof import("../runtime/credentials")>()),
  listCredentials: h.credentials,
  subscribeCredentialChanges: () => () => {},
}));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({ service: null, config: {} }),
  },
}));
vi.mock("../runtime/sessions", async (original) => ({
  ...(await original<typeof import("../runtime/sessions")>()),
  useThread: () => null,
  threads: { open: h.open, thread: () => null, discardDraft: vi.fn() },
}));
vi.mock("../runtime/new_conversation", () => ({ sendNewConversation: h.send }));
vi.mock(
  "../runtime/worktrees",
  () => import("../runtime/worktree_catalogue.test-fixture"),
);
import { EmptyState } from "./EmptyState";
import { Composer } from "./Composer";
import { NewConversationModelDialog } from "./NewConversationPickers";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import { allowAutomaticConnection } from "../runtime/connection_intent";
import { freshThreadState } from "../runtime/session_projection";
import type { AgentCardModel } from "../runtime/agents";
type Element = ReactElement<Record<string, unknown>>;
const props = {
  agents: [
    {
      id: "service-review",
      name: "Agent",
      status: "connected",
    } as AgentCardModel,
  ],
  onGoSettings: vi.fn(),
  onStarted: vi.fn(),
  onProjectChange: vi.fn(),
};
function nodes(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function render(): Element[] {
  for (let n = 0; n < 10; n++) {
    h.cursor = 0;
    const view = nodes(EmptyState(props));
    if (!h.effects.length) return view;
    h.effects.splice(0).forEach((effect) => effect());
  }
  throw new Error("render loop");
}
function composer(): Element {
  return render().find((node) => node.type === Composer)!;
}
const credential: Credential = {
  id: "api",
  label: "Service",
  provider: "custom",
  endpoint: "https://new.example/api",
  apiType: "responses",
  models: ["model"],
  revision: "current",
  fingerprint: "new-source",
  complete: true,
  deleting: false,
  grants: [],
};
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  h.credentials.mockReset().mockResolvedValue([credential]);
  h.open
    .mockReset()
    .mockResolvedValue(
      freshThreadState("prepared", "service-review", "/project", "native"),
    );
  h.send.mockReset();
  allowAutomaticConnection("service-review");
  Object.assign(newConversationChoice, {
    agentId: "service-review",
    cwd: "/project",
    reviewRequired: false,
    service: { id: "api", model: "model", revision: "old" },
    config: {},
  });
  composerDrafts.update("new", () => ({
    text: "Keep this draft",
    attachments: [],
  }));
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.useRealTimers();
  composerDrafts.clear("new");
});
it.each(["", "old"])(
  "blocks eager preparation and direct send of a cold saved API choice with revision %j",
  async (revision) => {
    newConversationChoice.service!.revision = revision;
    composer();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).not.toHaveBeenCalled();
    const view = composer();
    expect(view.props.disabled).toBe(true);
    await expect(
      (
        view.props.onSend as (
          blocks: unknown[],
          draft: unknown,
        ) => Promise<unknown>
      )([{ type: "text", text: "must not send" }], composerDrafts.read("new")),
    ).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new").text).toBe("Keep this draft");
  },
);
it.each(["model-removed", "deleting", "incomplete", "missing", "unreadable"])(
  "blocks preparation when the current service is %s even if its revision matches",
  async (kind) => {
    newConversationChoice.service!.revision = "current";
    h.credentials.mockResolvedValue(
      kind === "missing"
        ? []
        : [
            {
              ...credential,
              ...(kind === "model-removed"
                ? { models: [] }
                : kind === "deleting"
                  ? { deleting: true }
                  : { complete: false }),
            },
          ],
    );
    if (kind === "unreadable")
      h.credentials.mockRejectedValue(new Error("read failed"));
    composer();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.open).not.toHaveBeenCalled();
    expect(composer().props.disabled).toBe(true);
  },
);

it("prepares a current source only after explicit reselection and preserves the original text", async () => {
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).not.toHaveBeenCalled();
  const trigger = nodes(composer().props.controls as ReactNode).find(
    (node) => node.props["aria-label"] === "模型与来源",
  )!;
  (trigger.props.onClick as () => void)();
  const picker = render().find(
    (node) => node.type === NewConversationModelDialog,
  )!;
  await (picker.props.onApply as (value: unknown) => Promise<void>)({
    service: { id: "api", model: "model", revision: "current" },
    modelValue: null,
  });
  composer();
  await vi.advanceTimersByTimeAsync(300);
  expect(h.open).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      service: { id: "api", model: "model", revision: "current" },
      serviceRevision: "current",
    }),
  );
  expect(newConversationChoice.reviewRequired).toBe(false);
  expect(h.send).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe("Keep this draft");
});
