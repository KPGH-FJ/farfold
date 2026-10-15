import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { current: unknown }[],
  cleanup: [] as (() => void)[],
}));
vi.mock("react", () => ({
  useRef: (initial: unknown) => (h.slots[h.cursor++] ??= { current: initial }),
  useEffect: (effect: () => () => void) => {
    const slot = h.cursor++;
    if (!h.slots[slot]) {
      h.slots[slot] = { current: true };
      h.cleanup.push(effect());
    }
  },
}));
import { usePreparedComposerOwner } from "./usePreparedComposerOwner";
const render = (
  pair = "A|/selected-alias|/canonical|service",
  active = true,
) => {
  h.cursor = 0;
  return usePreparedComposerOwner(pair, active);
};
beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.cleanup = [];
});
afterEach(() => h.cleanup.forEach((cleanup) => cleanup()));
it("only a completed preparation can own its visible input, including an aliased work folder", () => {
  const view = render();
  expect(view.current("draft-A")).toBeNull();
  view.open("draft-A");
  expect(view.current("draft-A")?.()).toBe(true);
  expect(view.current("other")).toBeNull();
});
it("accepting another completed key immediately withdraws the prior editor owner", () => {
  const view = render();
  view.open("draft-A");
  const old = view.current("draft-A")!;
  view.open("draft-B");
  expect(old()).toBe(false);
  expect(view.current("draft-B")?.()).toBe(true);
});
it("an old prepared thread cannot acquire the fresh choice before its actual preparation finishes", () => {
  const original = render();
  original.open("draft-A");
  const old = original.current("draft-A")!;
  const choosing = render("B|/other|/other|service");
  expect(old()).toBe(false);
  expect(choosing.current("draft-A")).toBeNull();
  // A late success belonging to the old request cannot register in B.
  original.open("draft-A");
  expect(choosing.current("draft-A")).toBeNull();
  choosing.open("draft-B");
  expect(choosing.current("draft-B")?.()).toBe(true);
});
it.each(["choice-return", "hide-return"])(
  "returning after %s provides a fresh owner without reviving the old callback",
  (kind) => {
    const first = render();
    first.open("draft-A");
    const old = first.current("draft-A")!;
    if (kind === "choice-return") render("other");
    else render(undefined, false);
    const next = render().current("draft-A")!;
    expect(old()).toBe(false);
    expect(next()).toBe(true);
    h.cleanup.forEach((cleanup) => cleanup());
    expect(next()).toBe(false);
  },
);
