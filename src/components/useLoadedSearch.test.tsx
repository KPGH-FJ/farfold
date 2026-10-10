import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
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
    const index = h.cursor++,
      prior = h.slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps?.[i]))) {
      const slot = { deps, cleanup: prior?.cleanup };
      h.slots[index] = slot;
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() || undefined;
      });
    }
  },
}));
import { useLoadedSearch } from "./useLoadedSearch";
import { freshThreadState, applyUpdate } from "../runtime/session_projection";
const state = () => freshThreadState("a", "agent", "/controlled", "native");
let thread = state();
let query = "needle",
  revision = 0,
  enabled = true,
  keys = ["a"];
const states = new Map([["a", thread]]);
function render() {
  h.cursor = 0;
  const result = useLoadedSearch(keys, states, query, revision, enabled);
  const effects = h.effects.splice(0);
  if (effects.length) {
    effects.forEach((effect) => effect());
    return render();
  }
  return result;
}
function chunk(value: string) {
  applyUpdate(thread, {
    sessionUpdate: "user_message_chunk",
    messageId: "m",
    content: { type: "text", text: value },
  });
  revision++;
}
beforeEach(() => {
  vi.useFakeTimers();
  h.slots = [];
  h.effects = [];
  thread = state();
  states.set("a", thread);
  query = "needle";
  revision = 0;
  enabled = true;
  keys = ["a"];
  chunk("first needle");
});
afterEach(() => {
  h.slots.forEach((slot) => slot.cleanup?.());
  vi.useRealTimers();
});
it("finishes searches during continuous streaming instead of waiting for an idle debounce period", async () => {
  render();
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(40);
    chunk(" needle");
    render();
    if (i >= 3) expect(render().result?.matches).toBeGreaterThan(0);
  }
  expect(render().result?.matches).toBeGreaterThan(3);
});
it("keeps making progress when two live conversations swap recency order", async () => {
  const other = freshThreadState("b", "agent", "/controlled", "native-b");
  applyUpdate(other, {
    sessionUpdate: "user_message_chunk",
    messageId: "b",
    content: { type: "text", text: "second needle" },
  });
  states.set("b", other);
  keys = ["a", "b"];
  render();
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(40);
    chunk(" needle");
    keys = [...keys].reverse();
    render();
  }
  expect(render().result?.matches).toBeGreaterThan(2);
});
it("never presents an earlier query or scope as the current result", async () => {
  render();
  await vi.advanceTimersByTimeAsync(130);
  expect(render().result?.matches).toBe(1);
  query = "absent";
  expect(render().result).toBeNull();
  await vi.advanceTimersByTimeAsync(130);
  expect(render().result?.matches).toBe(0);
  keys = ["cold"];
  expect(render().result).toBeNull();
  await vi.advanceTimersByTimeAsync(130);
  expect(render().result).toMatchObject({ loaded: 0, unloaded: 1 });
});
it("cancels scheduled work when the body scope closes and does not publish a late scan", async () => {
  render();
  enabled = false;
  render();
  await vi.advanceTimersByTimeAsync(1000);
  expect(render()).toEqual({ result: null, busy: false, failed: false });
  enabled = true;
  render();
  await vi.advanceTimersByTimeAsync(130);
  expect(render().result?.matches).toBe(1);
});
