import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
const policy = vi.hoisted(() => ({
  ready: true,
  saving: false,
  error: null as string | null,
  cwd: "",
  locationEnabled: undefined as boolean | undefined,
  set: vi.fn(),
  setLocation: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => {
    policy.cwd = cwd ?? "";
    return { ...policy, enabled: () => false };
  },
}));
import { Composer } from "./Composer";
import { ComposerWorkNotice } from "./ComposerWorkNotice";
import { WorkspaceAccessControl } from "./WorkspaceAccessControl";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { freshThreadState, threads } from "../runtime/sessions";
import { queueEditorKey, startQueueEditor } from "../runtime/queue_edit";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";

afterEach(() => vi.restoreAllMocks());

// Render the real component and retain its event handlers, without a DOM or
// changes to production hooks. Nested Composer callbacks are exercised below.
function captureComposer(props: ComponentProps<typeof Composer>) {
  let tree: ReactNode;
  function Capture() {
    tree = Composer(props);
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  const elements: ReactElement<Record<string, unknown>>[] = [];
  const visit = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      if (child.type === ComposerWorkNotice)
        visit(
          ComposerWorkNotice(
            child.props as ComponentProps<typeof ComposerWorkNotice>,
          ),
        );
      else visit(child.props.children as ReactNode);
    });
  };
  visit(tree);
  return elements;
}

beforeEach(() => {
  policy.ready = true;
  policy.saving = false;
  policy.error = null;
  policy.locationEnabled = undefined;
  policy.set.mockClear();
  policy.setLocation.mockClear();
});

it("places the same read-only folder-status control in prepared and existing composers", () => {
  const thread = freshThreadState("owned", "fixture", "/owned", "native");
  thread.connectionId = "connection";
  for (const identity of ["draft", "established"] as const) {
    thread.identity = identity;
    const elements = captureComposer({
      thread,
      imageEnabled: false,
      onGoSettings() {},
    });
    const control = elements.find(
      (node) => node.type === WorkspaceAccessControl,
    );
    expect(control?.props.thread).toBe(thread);
    expect(control?.props.active).toBe(true);
  }
});

it("restores an explicitly paused location without changing a single Agent or sending its queue", () => {
  policy.locationEnabled = false;
  const elements = captureComposer({
    thread: null,
    workContext: { agentId: "selected", cwd: "/notes" },
    imageEnabled: false,
    disabled: true,
    editableWhenDisabled: true,
    onGoSettings() {},
  });
  const restore = elements.find(
    (node) =>
      node.type === "button" && node.props.children === "恢复此位置的发送",
  )!;
  expect(restore).toBeDefined();
  expect(restore.props.title).toContain("待发内容仍需手动发送");
  (restore.props.onClick as () => void)();
  expect(policy.setLocation).toHaveBeenCalledWith(true);
  expect(policy.set).not.toHaveBeenCalled();
});

it("offers an explicit enable action for the selected agent and folder before a conversation can be opened", () => {
  const html = renderToStaticMarkup(
    <Composer
      thread={null}
      workContext={{ agentId: "selected", cwd: "/notes" }}
      imageEnabled={false}
      disabled
      editableWhenDisabled
      onGoSettings={() => {}}
    />,
  );
  expect(policy.cwd).toBe("/notes");
  expect(html).toContain("恢复发送");
  expect(html).toContain('title="/notes"');
  expect(html).toMatch(/aria-label="发送" disabled/);
});

it("provides a retry when the work policy could not be read", () => {
  policy.ready = false;
  policy.error = "Unable to read policy";
  const html = renderToStaticMarkup(
    <Composer
      thread={null}
      workContext={{ agentId: "selected", cwd: "/notes" }}
      imageEnabled={false}
      disabled
      editableWhenDisabled
      onGoSettings={() => {}}
    />,
  );
  expect(html).toContain("Unable to read policy");
  expect(html).toContain("重试");
  expect(html).not.toContain("允许这个 Agent 工作");
});

it("offers recovery for an unknown first-message target without ordinary edit continuation", () => {
  composerDrafts.update("pending-target", () => ({
    text: "unconfirmed",
    attachments: [],
    sendPending: true,
    pendingConversation: { agentId: "a", cwd: "/p", nativeSessionId: "old" },
  }));
  const html = renderToStaticMarkup(
    <Composer
      thread={null}
      draftKey="pending-target"
      imageEnabled={false}
      onGoSettings={() => {}}
      onRecoverPending={async () => {}}
    />,
  );
  expect(html).toContain("查看对应对话");
  expect(html).toContain("放弃本次重试");
  expect(html).not.toContain("已检查，继续编辑");
  expect(html).toMatch(/aria-label="发送" disabled/);
});

it("does not save an old queue edit into the target chosen after it was cancelled during persistence", async () => {
  const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  const thread = threads.markOpenFailed(
    "a:/p:queue-cancel-race",
    "a",
    "/p",
    "queue-cancel-race",
    "fixture",
  );
  thread.openError = null;
  thread.queued = [
    [{ type: "text", text: "original A" }],
    [{ type: "text", text: "original B" }],
  ];
  const originalA = thread.queued[0];
  const originalB = thread.queued[1];
  const editingKey = queueEditorKey(thread.key);
  startQueueEditor(thread.key, 0, threads.beginQueueEdit(thread.key, 0));
  composerDrafts.update(editingKey, (draft) => ({
    ...draft,
    text: "edited A",
  }));
  const props = {
    thread,
    imageEnabled: false,
    onGoSettings: () => {},
  };
  const outer = captureComposer(props);
  const nested = outer.find((node) => node.type === Composer)!;
  const nestedProps = nested.props as ComponentProps<typeof Composer>;
  const onSend = vi.fn(nestedProps.onSend!);
  const inner = captureComposer({ ...nestedProps, onSend });
  let finishSave!: () => void;
  const save = new Promise<void>((resolve) => (finishSave = resolve));
  flush.mockReset().mockResolvedValueOnce().mockReturnValueOnce(save);
  const saveButton = inner.find(
    (node) =>
      node.type === "button" && node.props["aria-label"] === C.saveQueued,
  )!;
  expect(saveButton.props.disabled).toBe(false);
  (saveButton.props.onClick as () => void)();
  await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(2));

  const discard = outer.find(
    (node) =>
      node.type === "button" && node.props.children === C.discardQueueEdit,
  )!;
  (discard.props.onClick as () => void)();
  const editB = captureComposer(props).filter(
    (node) => node.type === "button" && node.props.children === C.editQueued,
  )[1];
  expect(editB.props.disabled).toBe(false);
  (editB.props.onClick as () => void)();
  const newDraft = composerDrafts.read(editingKey);
  const replace = vi.spyOn(threads, "replaceQueued");

  finishSave();
  await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  await expect(onSend.mock.results[0].value).rejects.toThrow(C.queueEditStale);
  expect(replace).not.toHaveBeenCalled();
  expect(thread.queued[0]).toBe(originalA);
  expect(thread.queued[1]).toBe(originalB);
  expect(composerDrafts.read(editingKey)).toBe(newDraft);
  expect(newDraft.text).toBe("original B");
});
