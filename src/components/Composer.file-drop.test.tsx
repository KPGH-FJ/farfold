import { afterEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  drop: null as null | { blocked?: () => boolean },
}));
vi.mock("./useComposerFileDrop", () => ({
  useComposerFileDrop: (options: typeof h.drop) => {
    h.drop = options;
    return { over: false, error: null };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
import { Composer } from "./Composer";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { STRINGS } from "../runtime/strings";
const key = "drop-during-send-preparation";
afterEach(() => {
  composerDrafts.clear(key);
  vi.restoreAllMocks();
  h.drop = null;
});
it("blocks native file import immediately while the first send save is still pending", async () => {
  let resolve!: () => void;
  const flush = vi
    .spyOn(draftPersistence, "flush")
    .mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue();
  composerDrafts.update(key, () => ({
    text: "explicit request",
    attachments: [],
  }));
  const onSend = vi.fn().mockResolvedValue(true);
  let tree: ReactNode;
  function Capture() {
    tree = Composer({
      thread: null,
      draftKey: key,
      imageEnabled: false,
      onGoSettings: () => {},
      onSend,
    });
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  let click!: () => void;
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (
        child.type === "button" &&
        child.props["aria-label"] === STRINGS.composer.sendTitle
      )
        click = child.props.onClick as () => void;
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  expect(h.drop?.blocked?.() ?? false).toBe(false);
  click();
  expect(flush).toHaveBeenCalledOnce();
  expect(composerDrafts.read(key).sendPending).not.toBe(true);
  expect(h.drop?.blocked?.() ?? false).toBe(true);
  expect(onSend).not.toHaveBeenCalled();
  resolve();
  await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(h.drop?.blocked?.()).toBe(false));
});
