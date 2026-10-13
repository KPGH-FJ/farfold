import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  audioAttachment,
  audioCapture,
} from "../runtime/audio_input.test-support";
import { AUDIO_INPUT as S } from "../runtime/audio_input";
import type { DraftAttachment } from "../runtime/drafts";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[]; cleanup?: () => void }[],
  effects: [] as (() => void)[],
  invoke: vi.fn(),
  read: vi.fn(),
  saved: vi.fn(),
  failApproved: false,
  hold: null as Promise<void> | null,
  writes: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState(initial: unknown) {
    const i = h.cursor++,
      s = h.slots[i] ?? (h.slots[i] = { value: initial });
    return [
      s.value,
      (value: unknown) => {
        s.value = value;
      },
    ];
  },
  useRef(current: unknown) {
    const i = h.cursor++;
    return (h.slots[i] ?? (h.slots[i] = { value: { current } })).value;
  },
  useEffect(setup: () => void | (() => void), deps: unknown[]) {
    const i = h.cursor++,
      old = h.slots[i];
    if (!old || deps.some((value, n) => !Object.is(value, old.deps?.[n]))) {
      const next = (h.slots[i] = { deps, cleanup: old?.cleanup });
      h.effects.push(() => {
        old?.cleanup?.();
        next.cleanup = setup() || undefined;
      });
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("../runtime/audio_input", async (original) => ({
  ...(await original<typeof import("../runtime/audio_input")>()),
  readAudioInput: h.read,
}));
type Node = ReactElement<Record<string, unknown>>;
const flatten = (tree: ReactNode): Node[] =>
  Children.toArray(tree).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...flatten(child.props.children as ReactNode)]
      : [],
  );
const text = (tree: ReactNode): string =>
  Children.toArray(tree)
    .map((child) =>
      isValidElement<{ children: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
let d: typeof import("../runtime/drafts");
let hook: typeof import("./useAudioComposerAttachments").useAudioComposerAttachments;
let context = "original",
  enabled = true,
  capability: boolean | undefined = true;
const original = (): DraftAttachment => ({
  id: "audio",
  kind: "file",
  name: "sample.wav",
  uri: "file:///chosen/sample.wav",
  mimeType: "audio/wav",
});
function render() {
  h.cursor = 0;
  const value = hook({
    draftKey: "new",
    context,
    enabled,
    capability,
    onSaved: h.saved,
    items: d.composerDrafts.read("new").attachments,
  });
  for (const effect of h.effects.splice(0)) effect();
  return value;
}
function nodes() {
  return flatten(render().dialog);
}
function action(label: string = S.read) {
  const value = render(),
    item = d.composerDrafts.read("new").attachments[0];
  const button = flatten(value.action(item)).find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  )!;
  expect(button.props.disabled).toBe(false);
  (button.props.onClick as () => void)();
}
function button(label: string) {
  return nodes().find(
    (n) => n.type === "button" && text(n.props.children as ReactNode) === label,
  )!;
}
function click(label: string) {
  const node = button(label);
  expect(node.props.disabled).not.toBe(true);
  (node.props.onClick as () => void)();
}
const statuses = () =>
  nodes()
    .filter((n) => n.props.role === "status")
    .map((n) => text(n.props.children as ReactNode));
const alerts = () =>
  nodes()
    .filter((n) => n.props.role === "alert")
    .map((n) => text(n.props.children as ReactNode));
async function ready() {
  action();
  await vi.waitFor(() => expect(button(S.confirm)?.props.disabled).toBe(false));
}
async function failSave() {
  await ready();
  h.failApproved = true;
  click(S.confirm);
  await vi.waitFor(() => expect(alerts()).toEqual([S.saveFailed]));
  return d.composerDrafts.read("new").attachments[0];
}
beforeEach(async () => {
  vi.resetModules();
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
  h.writes = [];
  h.failApproved = false;
  h.hold = null;
  context = "original";
  enabled = true;
  capability = true;
  h.saved.mockReset();
  h.read.mockReset().mockResolvedValue(audioCapture());
  h.invoke.mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === "settings_get") return null;
    if (cmd !== "settings_set") throw Error(`unexpected ${cmd}`);
    if (
      h.failApproved &&
      args.value.composers?.new?.attachments?.[0]?.localAudio
    )
      throw Error("controlled disk failure");
    if (h.hold) await h.hold;
    h.writes.push(args.value);
  });
  d = await import("../runtime/drafts");
  hook = (await import("./useAudioComposerAttachments"))
    .useAudioComposerAttachments;
  await d.draftPersistence.load();
  d.composerDrafts.update("new", () => ({
    text: "KEEP",
    attachments: [original()],
  }));
  await d.draftPersistence.flush();
  render();
});
afterEach(async () => {
  for (const slot of h.slots) slot.cleanup?.();
  h.failApproved = false;
  h.hold = null;
  await d.draftPersistence.flush();
});
it("never reads on ordinary selection, labels file position and has no player", () => {
  expect(h.read).not.toHaveBeenCalled();
  expect(
    text(render().action(d.composerDrafts.read("new").attachments[0])),
  ).toContain(S.filePosition);
  expect(nodes().some((n) => n.type === "audio")).toBe(false);
});
it.each([false, undefined])(
  "retains audio approval with capability %s and explains that sending is blocked",
  async (value) => {
    capability = value;
    await ready();
    expect(statuses()).toContain(
      value === false ? S.capabilityUnsupported : S.capabilityUnknown,
    );
    click(S.confirm);
    await vi.waitFor(() => expect(statuses()).toContain(S.saved));
    expect(d.composerDrafts.read("new").attachments[0].kind).toBe("audio");
    expect(
      h.invoke.mock.calls.every(([cmd]) => cmd.startsWith("settings_")),
    ).toBe(true);
  },
);
it.each([false, true])(
  "cancel restores exact previous object, approved=%s",
  async (approved) => {
    const selected = approved ? audioAttachment() : original();
    d.composerDrafts.update("new", () => ({
      text: "KEEP",
      attachments: [selected],
    }));
    action(approved ? S.reread : S.read);
    await vi.waitFor(() =>
      expect(button(S.confirm)?.props.disabled).toBe(false),
    );
    click(S.cancel);
    expect(d.composerDrafts.read("new").attachments[0]).toBe(selected);
    expect(statuses()).not.toContain(S.saved);
  },
);
it("cancel ignores a genuinely late native read completion", async () => {
  let finish!: (value: ReturnType<typeof audioCapture>) => void;
  h.read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const selected = d.composerDrafts.read("new").attachments[0];
  action();
  click(S.cancel);
  finish(audioCapture());
  await Promise.resolve();
  await Promise.resolve();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(selected);
  expect(nodes().some((n) => n.props.title === S.title)).toBe(false);
  expect(statuses()).not.toContain(S.saved);
});
it("context switch discards delayed confirmation without touching a new input", async () => {
  await ready();
  let finish!: (value: ReturnType<typeof audioCapture>) => void;
  h.read.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  click(S.confirm);
  await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  context = "changed";
  render();
  const kept = d.composerDrafts.read("new");
  finish(audioCapture());
  await Promise.resolve();
  await Promise.resolve();
  expect(d.composerDrafts.read("new")).toBe(kept);
  expect(kept.attachments[0].kind).toBe("file");
  expect(statuses()).not.toContain(S.saved);
});
it("save failure retains approved bytes and only a completed retry announces saved", async () => {
  const applied = await failSave();
  expect(h.saved).not.toHaveBeenCalled();
  expect(applied).toMatchObject(audioAttachment());
  expect(statuses()).not.toContain(S.saved);
  h.failApproved = false;
  let finish!: () => void;
  h.hold = new Promise((resolve) => {
    finish = resolve;
  });
  const retry = d.draftPersistence.flush();
  await vi.waitFor(() =>
    expect(d.draftPersistence.snapshot().saving).toBe(true),
  );
  expect(statuses()).not.toContain(S.saved);
  expect(alerts()).toEqual([S.saveFailed]);
  finish();
  await retry;
  expect(alerts()).toEqual([]);
  expect(statuses()).toContain(S.saved);
  expect(d.composerDrafts.read("new").attachments[0]).toBe(applied);
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.saved).toHaveBeenCalledOnce();
});
it.each(["remove-readd", "choice-revert", "sendPending"])(
  "save retry cannot announce an approval after %s",
  async (change) => {
    const applied = await failSave();
    if (change === "remove-readd") {
      d.composerDrafts.update("new", (v) => ({ ...v, attachments: [] }));
      d.composerDrafts.update("new", (v) => ({ ...v, attachments: [applied] }));
    }
    if (change === "choice-revert") {
      const old = d.newConversationChoice.agentId;
      d.newConversationChoice.agentId = "changed";
      d.composerDrafts.update("new", (v) => ({ ...v }));
      d.newConversationChoice.agentId = old;
    }
    if (change === "sendPending")
      d.composerDrafts.update("new", (v) => ({ ...v, sendPending: true }));
    h.failApproved = false;
    await d.draftPersistence.flush();
    expect(statuses()).not.toContain(S.saved);
  },
);
it("never offers an implicit reread of historical audio with no trusted source", () => {
  const old = {
    ...audioAttachment(),
    localAudio: null,
    uri: "file:///private/arbitrary.wav",
  };
  d.composerDrafts.update("new", () => ({ text: "KEEP", attachments: [old] }));
  const actions = flatten(render().action(old));
  expect(text(render().action(old))).toContain(S.sourceUnknown);
  expect(actions.find((n) => n.type === "button")?.props.disabled).toBe(true);
  expect(h.read).not.toHaveBeenCalled();
});
it("rejects non-WAV candidate explicitly without reading or silently changing file position", () => {
  const old = { ...original(), name: "sample.mp3", mimeType: "audio/mpeg" };
  d.composerDrafts.update("new", () => ({ text: "KEEP", attachments: [old] }));
  action();
  expect(alerts()).toEqual([S.unsupported]);
  expect(h.read).not.toHaveBeenCalled();
  expect(d.composerDrafts.read("new").attachments[0]).toBe(old);
});
