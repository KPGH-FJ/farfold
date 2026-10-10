import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
  type ComponentProps,
} from "react";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as {
    value?: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  }[],
  effects: [] as (() => void)[],
  choose: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
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
  useSyncExternalStore: (_s: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/dialogs", () => ({ chooseDirectory: h.choose }));
vi.mock("../runtime/setup_storage", () => ({
  useSetupStorage: () => ({}),
  setupStorage: { completed: () => false, confirmedSelection: () => null },
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => ({
    cwd,
    ready: true,
    enabled: () => false,
  }),
}));
import { EmptyState } from "./EmptyState";
import { WorkLocationPicker } from "./WorkLocationPicker";
import { Composer } from "./Composer";
import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
} from "../runtime/drafts";
import type { WorkLocationIntent } from "./WorktreeDialog";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
type Element = ReactElement<Record<string, unknown>>;
let props: ComponentProps<typeof EmptyState>;
function walk(tree: ReactNode): Element[] {
  const out: Element[] = [];
  Children.forEach(tree, (v) => {
    if (isValidElement<Record<string, unknown>>(v))
      out.push(v, ...walk(v.props.children as ReactNode));
  });
  return out;
}
function render() {
  for (let n = 0; n < 10; n++) {
    h.cursor = 0;
    const result = walk(EmptyState(props));
    if (!h.effects.length) return result;
    for (const e of h.effects.splice(0)) e();
  }
  throw new Error("render loop");
}
const intent = () =>
  (
    render().find((node) => node.type === WorkLocationPicker)!.props
      .begin as () => WorkLocationIntent
  )();
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.choose.mockReset();
  newConversationChoice.cwd = null;
  newConversationChoice.agentId = null;
  newConversationChoice.service = null;
  composerDrafts.update("new", () => ({ text: "keep", attachments: [] }));
  props = {
    agents: [],
    onGoSettings: vi.fn(),
    onProjectChange: vi.fn(),
    onStarted: vi.fn(),
  };
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.restoreAllMocks();
  composerDrafts.clear("new");
  newConversationChoice.cwd = null;
});
it("uses an explicitly confirmed location without sending or replacing the draft", async () => {
  const pick = intent();
  composerDrafts.update("new", (draft) => ({ ...draft, text: "latest edit" }));
  render();
  expect(pick.isCurrent()).toBe(true);
  expect(await pick.apply("/trees/new")).toBe(true);
  render();
  expect(newConversationChoice.cwd).toBe("/trees/new");
  expect(composerDrafts.read("new").text).toBe("latest edit");
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(render().find((n) => n.type === Composer)!.props.sendRequest).toBe(0);
  expect(pick.isCurrent()).toBe(false);
});
it("does not resurrect an old picker when the page is left and returned to", async () => {
  const pick = intent();
  props.active = false;
  render();
  props.active = true;
  render();
  expect(await pick.apply("/late")).toBe(false);
  expect(newConversationChoice.cwd).toBeNull();
});
it("ordinary directory changes retire worktree owners even when the path returns", async () => {
  const pick = intent();
  for (const path of ["/elsewhere", "/original"]) {
    h.choose.mockResolvedValueOnce(path);
    const button = render().find(
      (n) =>
        n.props["aria-label"] ===
        (newConversationChoice.cwd ? W.changeFolder : W.folder),
    )!;
    (button.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    render();
  }
  expect(await pick.apply("/late")).toBe(false);
  expect(newConversationChoice.cwd).toBe("/original");
});
it("rechecks original draft ownership after its save wait", async () => {
  let release!: () => void;
  vi.mocked(draftPersistence.flush).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pick = intent();
  const applying = pick.apply("/late");
  props.active = false;
  render();
  release();
  expect(await applying).toBe(false);
  expect(newConversationChoice.cwd).toBeNull();
});
it("save failure preserves content and does not apply the requested path", async () => {
  const pick = intent();
  vi.mocked(draftPersistence.flush).mockRejectedValueOnce(new Error("disk"));
  await expect(pick.apply("/late")).rejects.toThrow("disk");
  expect(newConversationChoice.cwd).toBeNull();
  expect(composerDrafts.read("new").text).toBe("keep");
});
it("an existing unknown send prevents adopting a late location", async () => {
  const pick = intent();
  composerDrafts.update("new", (draft) => ({ ...draft, sendPending: true }));
  expect(await pick.apply("/late")).toBe(false);
  expect(newConversationChoice.cwd).toBeNull();
});
