import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { Composer } from "./Composer";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { freshThreadState } from "../runtime/session_projection";

const draftKey = "ime-regression";
const defaults: ComponentProps<typeof Composer> = {
  thread: null,
  draftKey,
  imageEnabled: false,
  onGoSettings: () => {},
};

// Exercise the real textarea handler and draft/send caller, without replacing
// production hooks or sending any request to an Agent.
function textarea(extra: Partial<ComponentProps<typeof Composer>> = {}) {
  let tree: ReactNode;
  function Capture() {
    tree = Composer({ ...defaults, ...extra });
    return tree;
  }
  renderToStaticMarkup(<Capture />);
  let area: ReactElement<ComponentProps<"textarea">> | undefined;
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "textarea")
        area = child as ReactElement<ComponentProps<"textarea">>;
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return area!.props;
}

function key(
  native: { isComposing: boolean; keyCode: number },
  modifiers: Partial<KeyboardEvent<HTMLTextAreaElement>> = {},
) {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: native,
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

beforeEach(() => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  composerDrafts.update(draftKey, () => ({ text: "ceshi", attachments: [] }));
});
afterEach(() => {
  composerDrafts.clear(draftKey);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { isComposing: true, keyCode: 13 },
  // Legacy WebKit can end composition before dispatching this confirming key.
  { isComposing: false, keyCode: 229 },
])("leaves IME confirmation %j to the input method", (native) => {
  const onSend = vi.fn();
  const event = key(native);
  textarea({ onSend }).onKeyDown!(event);
  expect(draftPersistence.flush).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  expect(composerDrafts.read(draftKey).text).toBe("ceshi");
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])(
  "does not submit a modified IME Enter %j",
  (modifiers) => {
    const onSend = vi.fn();
    const event = key({ isComposing: false, keyCode: 229 }, modifiers);
    textarea({ onSend }).onKeyDown!(event);
    expect(draftPersistence.flush).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  },
);

it("sends committed text on the next ordinary Enter without a timing gate", async () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  textarea({ onSend }).onKeyDown!(key({ isComposing: false, keyCode: 229 }));
  expect(draftPersistence.flush).not.toHaveBeenCalled();
  composerDrafts.update(draftKey, (draft) => ({ ...draft, text: "测试" }));
  const event = key({ isComposing: false, keyCode: 13 });
  textarea({ onSend }).onKeyDown!(event);
  await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0]).toEqual([{ type: "text", text: "测试" }]);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(composerDrafts.read(draftKey).text).toBe(""));
});

it("keeps Shift Enter as a newline without preparing or sending", () => {
  const onSend = vi.fn();
  const prepareAction = vi.fn();
  const event = key({ isComposing: false, keyCode: 13 }, { shiftKey: true });
  textarea({ onSend, prepareAction }).onKeyDown!(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(draftPersistence.flush).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  expect(prepareAction).not.toHaveBeenCalled();
});

it("does not route an IME confirmation to Agent preparation", () => {
  const prepareAction = vi.fn();
  const event = key({ isComposing: false, keyCode: 229 });
  textarea({ disabled: true, editableWhenDisabled: true, prepareAction })
    .onKeyDown!(event);
  expect(prepareAction).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(composerDrafts.read(draftKey).text).toBe("ceshi");
});

it("does not save a queue edit on IME confirmation", () => {
  const saveEdit = vi.fn();
  textarea({ onSend: saveEdit, queueEditing: true }).onKeyDown!(
    key({ isComposing: false, keyCode: 229 }),
  );
  expect(draftPersistence.flush).not.toHaveBeenCalled();
  expect(saveEdit).not.toHaveBeenCalled();
  expect(composerDrafts.read(draftKey).text).toBe("ceshi");
});

it("leaves the command picker unchanged for IME confirmation, then selects on ordinary Enter without sending", () => {
  const thread = freshThreadState("ime-command", "a", "/fixture", "own");
  thread.availableCommands = [{ name: "help", description: "Help" }];
  composerDrafts.update(draftKey, () => ({ text: "/he", attachments: [] }));
  const onSend = vi.fn();
  const confirm = key({ isComposing: false, keyCode: 229 });
  textarea({ thread, onSend }).onKeyDown!(confirm);
  expect(composerDrafts.read(draftKey).text).toBe("/he");
  expect(confirm.preventDefault).not.toHaveBeenCalled();

  const select = key({ isComposing: false, keyCode: 13 });
  textarea({ thread, onSend }).onKeyDown!(select);
  expect(composerDrafts.read(draftKey).text).toBe("/help ");
  expect(select.preventDefault).toHaveBeenCalledOnce();
  expect(draftPersistence.flush).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
});
