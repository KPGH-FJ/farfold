import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";

const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  available: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (value: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: value } }).value,
  useState: (value: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value });
    return [slot.value, (next: unknown) => (slot.value = next)];
  },
  useEffect: (setup: () => void | (() => void), deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, index) => value !== slot.deps?.[index])
    ) {
      h.effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = setup() || undefined;
      });
      slot.deps = deps;
    }
  },
}));
vi.mock("../runtime/message_audio_compatibility", () => ({
  audioCompatibilityAvailable: h.available,
  prepareCompatibleAudio: h.prepare,
}));
import { MessageAudioCompatibility } from "./MessageAudioCompatibility";
import { MessageAttachmentMedia } from "./MessageAttachmentMedia";

type Element = ReactElement<{
  children?: ReactNode;
  ref?: { current: unknown };
  onClick?: () => void;
  onFailure?: () => void;
  disabled?: boolean;
  tabIndex?: number;
}>;
class Target {
  ownerDocument = page;
  focus = vi.fn(() => {
    page.activeElement = this;
  });
  contains(target: unknown) {
    return (
      target instanceof Target && (target === this || target.parent === this)
    );
  }
  constructor(readonly parent: Target | null = null) {}
}
const page = { activeElement: null as Target | null };
const group = new Target();
const prepare = new Target(group);
const cancel = new Target(group);
const audio = new Target(group);
const outside = new Target();

function nodes(tree: ReactNode): Element[] {
  return Children.toArray(tree).flatMap((child) =>
    isValidElement<Element["props"]>(child)
      ? [child, ...nodes(child.props.children)]
      : [],
  );
}
function render() {
  h.cursor = 0;
  const tree = MessageAudioCompatibility({
    source: "owned-audio",
    name: "audio",
  }) as Element;
  if (tree.props.ref) tree.props.ref.current = group;
  for (const effect of h.effects.splice(0)) effect();
  return tree;
}
function button(tree: Element, text: string) {
  const control = nodes(tree).find(
    (node) => node.type === "button" && node.props.children === text,
  );
  expect(control).toBeDefined();
  return control!.props;
}

async function preparing() {
  let resolve!: (audio: { src: string; dispose: () => void }) => void;
  let reject!: (error: Error) => void;
  h.prepare.mockReturnValueOnce(
    new Promise((ready, failed) => {
      resolve = ready;
      reject = failed;
    }),
  );
  render();
  await Promise.resolve();
  prepare.focus();
  button(render(), S.audioCompatibility).onClick?.();
  const pending = render();
  return {
    pending,
    resolve,
    reject,
    signal: h.prepare.mock.calls[0][1] as AbortSignal,
  };
}

beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.available.mockReset().mockResolvedValue(true);
  h.prepare.mockReset();
  group.focus.mockClear();
  page.activeElement = outside;
});
afterEach(() => {
  for (const slot of h.slots) slot.cleanup?.();
});

it("keeps keyboard position when preparation disables the trigger and cancellation removes its button", async () => {
  const { pending, signal } = await preparing();
  expect(button(pending, S.audioCompatibility).disabled).toBe(true);
  expect(pending.props.tabIndex).toBe(-1);
  expect(page.activeElement).toBe(group);
  cancel.focus();
  button(pending, S.audioCompatibilityCancel).onClick?.();
  expect(signal.aborted).toBe(true);
  expect(page.activeElement).toBe(group);
  expect(button(render(), S.audioCompatibility).disabled).toBe(false);
});

it("retains focus for the player and the retry when the currently focused control disappears", async () => {
  const { resolve } = await preparing();
  cancel.focus();
  const dispose = vi.fn();
  resolve({ src: "blob:owned-audio", dispose });
  await Promise.resolve();
  expect(page.activeElement).toBe(group);
  const player = nodes(render()).find(
    (node) => node.type === MessageAttachmentMedia,
  );
  expect(player).toBeDefined();
  audio.focus();
  player!.props.onFailure?.();
  expect(dispose).toHaveBeenCalledOnce();
  expect(page.activeElement).toBe(group);
  expect(button(render(), S.audioCompatibility).disabled).toBe(false);
});

it("does not move focus back after the user leaves the compatibility controls", async () => {
  const { resolve } = await preparing();
  outside.focus();
  resolve({ src: "blob:owned-audio", dispose: vi.fn() });
  await Promise.resolve();
  expect(page.activeElement).toBe(outside);
});

it("keeps focus in the controls if conversion fails while Cancel is focused", async () => {
  const { reject } = await preparing();
  cancel.focus();
  reject(new Error(S.audioCompatibilityFailed));
  await Promise.resolve();
  expect(page.activeElement).toBe(group);
  expect(button(render(), S.audioCompatibility).disabled).toBe(false);
});
