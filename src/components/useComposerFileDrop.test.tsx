import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileDropEvent } from "../runtime/composer_file_drop";
const h = vi.hoisted(() => ({
  effects: [] as (() => (() => void) | void)[],
  subscribe: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useEffect: (run: () => (() => void) | void) => {
    h.effects.push(run);
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: h.subscribe }),
}));
import { useComposerFileDrop } from "./useComposerFileDrop";
import { composerDrafts } from "../runtime/drafts";
import { draftPersistence } from "../runtime/draft_storage";

const key = "native-file-drop";
function mount(enabled = true) {
  let callback: (event: { payload: FileDropEvent }) => void;
  let finish: (stop: () => void) => void;
  let fail: () => void;
  h.subscribe.mockImplementation((next) => {
    callback = next;
    return new Promise<void>((resolve, reject) => {
      finish = resolve as never;
      fail = () => reject(new Error("partial registration failed"));
    });
  });
  const add = vi.fn();
  const blocked = vi.fn().mockReturnValue(false);
  const element = {
    closest: vi.fn().mockReturnValue(null),
    getBoundingClientRect: () => ({
      left: 100,
      top: 200,
      right: 300,
      bottom: 400,
      width: 200,
      height: 200,
    }),
    ownerDocument: { elementFromPoint: vi.fn() },
    contains: (hit: unknown) => hit === element,
  };
  element.ownerDocument.elementFromPoint.mockReturnValue(element);
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  function Probe() {
    useComposerFileDrop({
      key,
      enabled,
      blocked,
      add,
      box: { current: element as unknown as HTMLDivElement },
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  const cleanup = h.effects.pop()!()!;
  const send = (type: "enter" | "drop", position = { x: 220, y: 420 }) =>
    callback!({ payload: { type, paths: ["/file.txt"], position } });
  return {
    send,
    add,
    blocked,
    element,
    finish: (stop: () => void) => finish!(stop),
    fail: () => fail!(),
    cleanup,
  };
}
afterEach(() => {
  h.effects.length = 0;
  h.subscribe.mockReset();
  composerDrafts.clear(key);
  draftPersistence.lockInteraction(false);
  vi.unstubAllGlobals();
});
it("converts Retina physical coordinates and imports only the hit input", () => {
  const s = mount();
  s.send("enter");
  s.send("drop");
  expect(s.element.ownerDocument.elementFromPoint).toHaveBeenLastCalledWith(
    110,
    210,
  );
  expect(s.add).toHaveBeenCalledExactlyOnceWith(key, ["/file.txt"]);
  s.cleanup();
});
it.each(["hidden", "covered", "inert", "pending", "exit", "preparing"])(
  "does not add files through %s input",
  (reason) => {
    const s = mount();
    s.send("enter");
    if (reason === "hidden")
      s.element.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      });
    if (reason === "covered")
      s.element.ownerDocument.elementFromPoint.mockReturnValue({});
    if (reason === "inert") s.element.closest.mockReturnValue({});
    if (reason === "pending")
      composerDrafts.update(key, (draft) => ({
        ...draft,
        text: "being sent",
        sendPending: true,
      }));
    if (reason === "exit") draftPersistence.lockInteraction(true);
    if (reason === "preparing") s.blocked.mockReturnValue(true);
    s.send("drop");
    expect(s.add).not.toHaveBeenCalled();
    s.cleanup();
  },
);
it("refuses an inactive composer without registering an import", () => {
  const s = mount(false);
  s.send("enter");
  s.send("drop");
  expect(s.add).not.toHaveBeenCalled();
  s.cleanup();
});
it("unlistens a subscription that resolves after unmount and ignores late events", async () => {
  const s = mount();
  s.send("enter");
  s.cleanup();
  const stop = vi.fn();
  s.finish(stop);
  await Promise.resolve();
  s.send("drop");
  expect(stop).toHaveBeenCalledOnce();
  expect(s.add).not.toHaveBeenCalled();
});
it("detaches a resolved subscription on unmount", async () => {
  const s = mount();
  const stop = vi.fn();
  s.finish(stop);
  await Promise.resolve();
  s.cleanup();
  expect(stop).toHaveBeenCalledOnce();
});

it("disables partial native callbacks after registration rejects", async () => {
  const s = mount();
  s.send("enter");
  s.fail();
  await Promise.resolve();
  s.send("drop");
  s.send("enter");
  s.send("drop");
  expect(s.add).not.toHaveBeenCalled();
  s.cleanup();
});
