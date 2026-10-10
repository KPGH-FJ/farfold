import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; cleanup?: () => void }[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current } }).value,
  useEffect: (fn: () => void | (() => void)) => {
    const i = h.cursor++;
    if (!h.slots[i]) h.slots[i] = { cleanup: fn() || undefined };
  },
}));
import { useDraftPreparation } from "./useDraftPreparation";
import {
  composerDrafts,
  draftPersistence,
  newConversationChoice,
} from "../runtime/drafts";
let props: Parameters<typeof useDraftPreparation>[0];
const render = () => {
  h.cursor = 0;
  return useDraftPreparation(props);
};
beforeEach(() => {
  h.slots = [];
  h.cursor = 0;
  vi.spyOn(draftPersistence, "snapshot").mockReturnValue({
    ...draftPersistence.snapshot(),
    interactionLocked: false,
  });
  newConversationChoice.cwd = "/repo/tree";
  composerDrafts.update("new", () => ({ text: "keep", attachments: [] }));
  props = {
    context: "A",
    cwd: "/repo/tree",
    active: true,
    allowed: () => true,
    onBegin: vi.fn(),
  };
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.restoreAllMocks();
  composerDrafts.clear("new");
});
it("creates a fresh preparation owner independently of the already-consumed Use intent", () => {
  const begin = render(),
    first = begin()!;
  expect(first.isCurrent()).toBe(true);
  const second = begin()!;
  expect(second.owner).not.toBe(first.owner);
  expect(first.isCurrent()).toBe(false);
  expect(second.isCurrent()).toBe(true);
  expect(props.onBegin).toHaveBeenCalledTimes(2);
});
it("A -> B -> A, hide/reopen and unmount cannot revive an old callback", () => {
  const first = render()()!;
  props = { ...props, context: "B" };
  render();
  props = { ...props, context: "A" };
  render();
  expect(first.isCurrent()).toBe(false);
  const second = render()()!;
  props = { ...props, active: false };
  render();
  props = { ...props, active: true };
  render();
  expect(second.isCurrent()).toBe(false);
  const third = render()()!;
  h.slots.forEach((slot) => slot.cleanup?.());
  expect(third.isCurrent()).toBe(false);
});
it("synchronous begin withdrawal cannot create an append target", () => {
  props.onBegin = () => {
    props = { ...props, active: false };
    render();
  };
  expect(render()()).toBe(null);
});
