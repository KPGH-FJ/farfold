import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
import { Composer } from "./Composer";
import { AttachmentRecovery } from "./AttachmentRecovery";
import {
  composerDrafts,
  draftPersistence,
  draftQueues,
} from "../runtime/drafts";
import { threads } from "../runtime/sessions";
import {
  captureAttachmentReview,
  confirmAttachmentReview,
} from "../runtime/attachment_review";
import { STRINGS } from "../runtime/strings";
import { queueEditorKey, startQueueEditor } from "../runtime/queue_edit";
import { COMPOSER_CONTROLS } from "../runtime/composer_strings";
type Element = ReactElement<Record<string, unknown>>;
function capture(props: ComponentProps<typeof Composer>) {
  let tree: ReactNode;
  function Capture() {
    tree = Composer(props);
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  const elements: Element[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return { html, elements };
}
afterEach(() => vi.restoreAllMocks());

it("requires explicit attachment review in a restored new draft and does not send after confirming", async () => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  composerDrafts.update("new-attachment-gate", () => ({
    text: "Keep text",
    attachments: [
      {
        id: "file",
        name: "file.txt",
        kind: "file",
        uri: "file:///file.txt",
        recovered: true,
      },
    ],
  }));
  const onSend = vi.fn();
  const props = {
    thread: null,
    imageEnabled: false,
    draftKey: "new-attachment-gate",
    onGoSettings() {},
    onSend,
  };
  const before = capture(props);
  expect(before.html).toContain("核对恢复的附件");
  const send = before.elements.find(
    (node) => node.props["aria-label"] === STRINGS.composer.sendTitle,
  )!;
  expect(send.props.disabled).toBe(true);
  (send.props.onClick as () => void)();
  expect(onSend).not.toHaveBeenCalled();
  const review = captureAttachmentReview(props.draftKey, null);
  await confirmAttachmentReview(
    review,
    new Set(["draft:0"]),
    false,
    () => true,
  );
  const after = capture(props);
  expect(
    after.elements.find(
      (node) => node.props["aria-label"] === STRINGS.composer.sendTitle,
    )!.props.disabled,
  ).toBe(false);
  expect(onSend).not.toHaveBeenCalled();
  expect(composerDrafts.read(props.draftKey).text).toBe("Keep text");
});

it("blocks the restored queue's Continue action and scopes queue-edit recovery to its independent draft", () => {
  const key = "composer-attachment-queue";
  draftQueues.write(
    key,
    [
      [
        { type: "text", text: "queued" },
        { type: "image", data: "saved", mimeType: "image/png" },
      ],
    ],
    null,
  );
  const thread = threads.markOpenFailed(key, "a", "/p", key, "fixture");
  thread.openError = null;
  const props = { thread, imageEnabled: true, onGoSettings() {} };
  const view = capture(props);
  expect(view.html).toContain("核对恢复的附件");
  expect(
    view.elements.find(
      (node) => node.props.children === STRINGS.repair.continueQueue,
    )!.props.disabled,
  ).toBe(true);
  const recovery = view.elements.find(
    (node) => node.type === AttachmentRecovery,
  )!;
  expect(recovery.props.thread).toBe(thread);
  startQueueEditor(key, 0, threads.beginQueueEdit(key, 0));
  const editor = capture({
    ...props,
    draftKey: queueEditorKey(key),
    queueEditing: true,
  });
  expect(
    editor.elements.find((node) => node.type === AttachmentRecovery)!.props
      .thread,
  ).toBeNull();
  expect(
    editor.elements.find(
      (node) => node.props["aria-label"] === COMPOSER_CONTROLS.saveQueued,
    )!.props.disabled,
  ).toBe(true);
});
