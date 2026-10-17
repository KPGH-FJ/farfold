import { afterEach, expect, it, vi } from "vitest";
import type { Attachment } from "./session_types";

type Effect = () => void | (() => void);
type Slot = {
  value?: unknown;
  deps?: readonly unknown[];
  effect?: Effect;
  cleanup?: void | (() => void);
};
type Owner = {
  cursor: number;
  slots: Slot[];
  effects: (() => void)[];
  dirty: boolean;
  alive: boolean;
};
const h = vi.hoisted(() => ({ active: null as Owner | null }));

// Deterministic Hook/layout-commit simulation, following the component mocks.
// These checks exercise the real shared pool, not a browser or a codec.
vi.mock("react", async (original) => {
  const owner = () => {
    if (!h.active) throw new Error("Hook called without an owner");
    return h.active;
  };
  const changed = (slot: Slot, deps: readonly unknown[]) =>
    !slot.deps ||
    deps.length !== slot.deps.length ||
    deps.some((value, index) => !Object.is(value, slot.deps![index]));
  return {
    ...(await original<typeof import("react")>()),
    useState: (initial: unknown) => {
      const instance = owner();
      const slot = (instance.slots[instance.cursor++] ??= {
        value: typeof initial === "function" ? initial() : initial,
      });
      return [
        slot.value,
        (update: unknown) => {
          if (!instance.alive) return;
          const value =
            typeof update === "function" ? update(slot.value) : update;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            instance.dirty = true;
          }
        },
      ];
    },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => {
      const instance = owner();
      const slot = (instance.slots[instance.cursor++] ??= {});
      if (changed(slot, deps)) {
        slot.value = factory();
        slot.deps = [...deps];
      }
      return slot.value;
    },
    useRef: (initial: unknown) => {
      const instance = owner();
      return (instance.slots[instance.cursor++] ??= {
        value: { current: initial },
      }).value;
    },
    useLayoutEffect: (effect: Effect, deps: readonly unknown[]) => {
      const instance = owner();
      const slot = (instance.slots[instance.cursor++] ??= {});
      slot.effect = effect;
      if (changed(slot, deps)) {
        slot.deps = [...deps];
        instance.effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
});

import { useMessageMediaPreview } from "./use_message_media_budget";
import {
  MAX_ACTIVE_MESSAGE_MEDIA_BYTES,
  messageMediaBudget,
  type MessageMediaLease,
} from "./message_media_budget";
import { MESSAGE_AUDIO_WAV_TEST_DATA } from "./message_audio_fixtures.test-support";

// The expected failure API is asserted at runtime against the old Hook too.
type Preview = ReturnType<typeof useMessageMediaPreview> & {
  failed: boolean;
  fail(): void;
};
type HookInstance = {
  render(attachment?: Attachment, enabled?: boolean): Preview;
  read(): Preview;
  replayEffects(): Preview;
  unmount(): void;
};
const source: Attachment = {
  name: "original.wav",
  mimeType: "audio/wav",
  data: MESSAGE_AUDIO_WAV_TEST_DATA,
};
const changedBytes = Buffer.from(source.data!, "base64");
changedBytes[changedBytes.length - 1] ^= 1;
const otherSource: Attachment = {
  ...source,
  name: "other.wav",
  data: changedBytes.toString("base64"),
};
const sourceBytes = Buffer.from(source.data!, "base64").length;
const instances: HookInstance[] = [];
const held: MessageMediaLease[] = [];

function acquire(bytes = 1) {
  const lease = messageMediaBudget.acquire(bytes);
  if (lease) held.push(lease);
  return lease;
}
function fillOtherSlots() {
  return Array.from({ length: 3 }, () => {
    const lease = acquire();
    expect(lease).not.toBeNull();
    return lease!;
  });
}
function mount(attachment = source, enabled = true): HookInstance {
  const owner: Owner = {
    cursor: 0,
    slots: [],
    effects: [],
    dirty: false,
    alive: true,
  };
  let value: Preview;
  const render = (next = attachment, nextEnabled = enabled): Preview => {
    attachment = next;
    enabled = nextEnabled;
    let renders = 0;
    do {
      if (++renders > 12) throw new Error("Hook did not settle");
      owner.cursor = 0;
      owner.dirty = false;
      h.active = owner;
      try {
        value = useMessageMediaPreview(attachment, enabled) as Preview;
      } finally {
        h.active = null;
      }
      for (const effect of owner.effects.splice(0)) effect();
    } while (owner.dirty);
    return value;
  };
  const instance = {
    render,
    read: () => value,
    replayEffects: () => {
      for (const slot of owner.slots) {
        slot.cleanup?.();
        slot.cleanup = undefined;
      }
      for (const slot of owner.slots) {
        if (slot.effect) slot.cleanup = slot.effect();
      }
      return render();
    },
    unmount: () => {
      if (!owner.alive) return;
      owner.alive = false;
      for (const slot of owner.slots) slot.cleanup?.();
    },
  };
  instances.push(instance);
  render();
  return instance;
}

afterEach(() => {
  for (const instance of instances.splice(0)) instance.unmount();
  for (const lease of held.splice(0)) lease.release();
  h.active = null;
});

it("keeps disabled media out of the shared pool", () => {
  for (let index = 0; index < 4; index++) expect(acquire()).not.toBeNull();
  const preview = mount(source, false).read();
  expect(preview.admission).toBeNull();
  expect(preview.media).toBeNull();
  expect(preview.pending).toBe(false);
  expect(preview.budgetRejected).toBe(false);
});

it("releases a failed preview slot and retains failure instead of quota feedback", () => {
  const preview = mount();
  fillOtherSlots();
  expect(preview.read().media?.src).toContain(source.data);
  expect(acquire()).toBeNull();
  preview.read().fail();
  const failed = preview.render();
  expect(failed.failed).toBe(true);
  expect(failed.media).toBeNull();
  expect(failed.budgetRejected).toBe(false);
  expect(failed.pending).toBe(false);
  expect(acquire()).not.toBeNull();
  expect(acquire()).toBeNull();
});

it("makes repeated failure idempotent after another preview takes the slot", () => {
  const preview = mount();
  fillOtherSlots();
  const fail = preview.read().fail;
  fail();
  preview.render();
  expect(acquire()).not.toBeNull();
  fail();
  preview.render().fail();
  expect(acquire()).toBeNull();
  expect(preview.read().media).toBeNull();
});

it("rechecks quota on explicit retry and never auto-retries when another owner releases", () => {
  const preview = mount();
  const others = fillOtherSlots();
  preview.read().fail();
  preview.render();
  expect(acquire()).not.toBeNull();
  preview.read().retry();
  let current = preview.render();
  expect(current.failed).toBe(false);
  expect(current.budgetRejected).toBe(true);
  expect(current.media).toBeNull();
  others[0].release();
  current = preview.render();
  expect(current.budgetRejected).toBe(true);
  expect(current.media).toBeNull();
  current.retry();
  current = preview.render();
  expect(current.failed).toBe(false);
  expect(current.budgetRejected).toBe(false);
  expect(current.media?.src).toContain(source.data);
});

it("does not let an old failure callback release or fail a successful retry", () => {
  const preview = mount();
  fillOtherSlots();
  const oldFail = preview.read().fail;
  oldFail();
  preview.render().retry();
  const retried = preview.render();
  expect(retried.media?.src).toContain(source.data);
  expect(acquire()).toBeNull();
  oldFail();
  const current = preview.render();
  expect(current.failed).toBe(false);
  expect(current.media?.src).toBe(retried.media?.src);
  expect(acquire()).toBeNull();
});

it("retires only the old source lease when a source changes", () => {
  const preview = mount();
  fillOtherSlots();
  const oldFail = preview.read().fail;
  let current = preview.render(otherSource);
  expect(current.media?.src).toContain(otherSource.data);
  expect(acquire()).toBeNull();
  oldFail();
  current = preview.render();
  expect(current.failed).toBe(false);
  expect(current.media?.src).toContain(otherSource.data);
  expect(acquire()).toBeNull();
});

it("keeps a different owner admitted while a failed owner collapses and reopens", () => {
  const first = mount();
  const second = mount(otherSource);
  expect(acquire()).not.toBeNull();
  expect(acquire()).not.toBeNull();
  const oldFail = first.read().fail;
  oldFail();
  first.render(source, false);
  expect(acquire()).not.toBeNull();
  expect(second.render().media?.src).toContain(otherSource.data);
  const reopened = first.render(source, true);
  expect(reopened.budgetRejected).toBe(true);
  expect(reopened.media).toBeNull();
  oldFail();
  expect(second.render().media?.src).toContain(otherSource.data);
  expect(acquire()).toBeNull();
});

it("keeps the replacement lease after layout-effect replay and late failure", () => {
  const preview = mount();
  fillOtherSlots();
  const oldFail = preview.read().fail;
  const replayed = preview.replayEffects();
  expect(replayed.media?.src).toContain(source.data);
  expect(acquire()).toBeNull();
  oldFail();
  const current = preview.render();
  expect(current.failed).toBe(false);
  expect(current.media?.src).toContain(source.data);
  expect(acquire()).toBeNull();
});

it("does not let unmount cleanup or late failure release another owner's lease", () => {
  const first = mount();
  const second = mount(otherSource);
  const oldFail = first.read().fail;
  first.unmount();
  expect(acquire()).not.toBeNull();
  expect(acquire()).not.toBeNull();
  expect(acquire()).not.toBeNull();
  oldFail();
  expect(acquire()).toBeNull();
  expect(second.render().media?.src).toContain(otherSource.data);
});

it("recovers admitted file bytes on failure without releasing someone else's bytes", () => {
  const preview = mount();
  expect(acquire(MAX_ACTIVE_MESSAGE_MEDIA_BYTES - sourceBytes)).not.toBeNull();
  expect(acquire()).toBeNull();
  const oldFail = preview.read().fail;
  oldFail();
  preview.render();
  expect(acquire(sourceBytes)).not.toBeNull();
  expect(acquire()).toBeNull();
  oldFail();
  preview.unmount();
  expect(acquire()).toBeNull();
});
