import { NewConversationLocationBar } from "./NewConversationLocationBar";
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
  catalogue: {
    ready: true,
    loading: false,
    error: null,
    archives: [] as { originalPath: string }[],
    recoveries: [],
  },
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
vi.mock("../runtime/worktrees", () => ({
  worktrees: {
    snapshot: () => h.catalogue,
    subscribe: () => () => {},
    load: vi.fn().mockResolvedValue(undefined),
  },
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
import { WorktreePreparationControl } from "./WorktreePreparationControl";
import type { PreparationDraftTarget } from "../runtime/draft_preparation";
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
    if (isValidElement<Record<string, unknown>>(v)) {
      out.push(v, ...walk(v.props.children as ReactNode));
      if (v.type === NewConversationLocationBar)
        out.push(
          ...walk(
            NewConversationLocationBar(
              v.props as ComponentProps<typeof NewConversationLocationBar>,
            ),
          ),
        );
    }
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
  h.catalogue = {
    ready: true,
    loading: false,
    error: null,
    archives: [],
    recoveries: [],
  };
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
const preparation = () =>
  (
    render().find((node) => node.type === WorktreePreparationControl)!.props
      .begin as () => PreparationDraftTarget | null
  )();
it("Use retires its location token, then explicit preparation appends to the same draft without sending", async () => {
  const original = composerDrafts.read("new");
  const pick = intent();
  expect(await pick.apply("/trees/new")).toBe(true);
  render();
  expect(pick.isCurrent()).toBe(false);
  const prepare = preparation()!;
  expect(prepare.isCurrent()).toBe(true);
  expect(composerDrafts.read("new")).toBe(original);
  expect(await prepare.appendOnce("Prepare tests", async () => {})).toBe(
    "added-saved",
  );
  expect(composerDrafts.read("new").text).toBe("keep\n\nPrepare tests");
  expect(props.onStarted).not.toHaveBeenCalled();
  expect(render().find((n) => n.type === Composer)!.props.sendRequest).toBe(0);
});
it("hide/new page and a remembered archived cwd cannot receive a late preparation", async () => {
  await intent().apply("/trees/new");
  render();
  const prepare = preparation()!;
  props.active = false;
  render();
  props.active = true;
  render();
  expect(await prepare.appendOnce("Late", async () => {})).toBe("stale");
  h.catalogue.archives = [{ originalPath: "/trees/new" }];
  render();
  expect(preparation()).toBe(null);
  expect(composerDrafts.read("new").text).toBe("keep");
});
it("a new path choice never lets an old preparation update the replacement draft", async () => {
  await intent().apply("/trees/new");
  render();
  const prepare = preparation()!;
  await intent().apply("/trees/other");
  render();
  expect(await prepare.appendOnce("Late", async () => {})).toBe("stale");
  expect(newConversationChoice.cwd).toBe("/trees/other");
  expect(composerDrafts.read("new").text).toBe("keep");
});
