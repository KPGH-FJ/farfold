import { beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraft } from "../runtime/drafts";
const h = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as { value?: unknown; deps?: unknown[] }[],
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: initial } }).value,
  useEffect: (effect: () => void, deps: unknown[]) => {
    const slot = (h.slots[h.cursor++] ??= {});
    if (
      !slot.deps ||
      deps.some((value, i) => !Object.is(value, slot.deps?.[i]))
    )
      h.effects.push(effect);
    slot.deps = deps;
  },
}));
import { useDraftSendIntent } from "./useDraftSendIntent";

beforeEach(() => {
  h.cursor = 0;
  h.slots = [];
  h.effects = [];
});
type View = Parameters<typeof useDraftSendIntent>[0];
function render(view: View) {
  h.cursor = 0;
  const send = useDraftSendIntent(view);
  for (const effect of h.effects.splice(0)) effect();
  return send;
}

it.each([false, true])(
  "a folderless send keeps its one-shot only while file delivery intent is unchanged (changed: %s)",
  async (changed) => {
    const draft: ComposerDraft = {
      text: "keep",
      attachments: [
        {
          id: "notes",
          kind: "file",
          name: "notes.txt",
          uri: "file:///owned/notes.txt",
          deliveryMode: "location",
        },
      ],
    };
    let view: View = {
      pending: { current: null },
      pair: "A:",
      cwd: null,
      active: true,
      ready: false,
      error: false,
      draft,
      requireCurrent: vi.fn(),
      retireLocation: vi.fn(),
      prepare: vi.fn(),
      send: vi.fn(),
      pickProject: vi.fn().mockResolvedValue(true),
      requestSend: vi.fn(),
      folderCancelled: vi.fn(),
    };
    expect(await render(view)([], draft)).toBe(false);
    expect(view.pending.current).not.toBeNull();
    expect(view.send).not.toHaveBeenCalled();
    view = { ...view, pair: "A:/picked", cwd: "/picked" };
    render(view);
    if (changed) {
      view = {
        ...view,
        draft: {
          ...draft,
          attachments: draft.attachments.map((item) => ({
            ...item,
            deliveryMode: "text",
          })),
        },
      };
      render(view);
      expect(view.pending.current).toBeNull();
    }
    view = { ...view, ready: true };
    render(view);
    render(view);
    expect(view.requestSend).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(view.pending.current).toBeNull();
    expect(view.send).not.toHaveBeenCalled();
  },
);
