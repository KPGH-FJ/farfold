import { beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
const h = vi.hoisted(() => ({ cursor: 0, slots: [] as { value: unknown }[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const slot = (h.slots[h.cursor++] ??= { value: initial });
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === "function" ? value(slot.value) : value;
      },
    ];
  },
  useRef: (value: unknown) =>
    (h.slots[h.cursor++] ??= { value: { current: value } }).value,
  useId: () => "fixture-attachments",
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { ComposerAttachments } from "./ComposerAttachments";
import { SessionOptionsList } from "./SessionOptionsMenu";
import { ModelPicker } from "./ModelPicker";
import { ReasoningControl } from "./ReasoningControl";
import { ConfigurationChangeReview } from "./ConfigurationChangeReview";
import { MessageResendDialog } from "./MessageResendDialog";
import { Composer } from "./Composer";
import { freshThreadState, threads } from "../runtime/sessions";
import {
  composerDrafts,
  draftPersistence,
  type DraftAttachment,
} from "../runtime/drafts";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import { configurationInputBusy } from "../runtime/config_check";
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function render(read: () => ReactNode) {
  h.cursor = 0;
  return nodes(read());
}
beforeEach(() => {
  h.slots = [];
  vi.restoreAllMocks();
});
it("collapses attachment presentation without dropping files, expands full paths, and removes by stable id", () => {
  const items: DraftAttachment[] = Array.from({ length: 5 }, (_, n) => ({
    id: `${n}`,
    kind: "file",
    name: "修改意见.md",
    uri: `file:///版本${n}/修改意见.md`,
  }));
  const remove = vi.fn();
  const read = () => ComposerAttachments({ items, onRemove: remove });
  let view = render(read);
  expect(view.filter((node) => node.props.className === "c-chip")).toHaveLength(
    3,
  );
  const toggle = view.find(
    (node) => node.props["aria-controls"] === "fixture-attachments",
  )!;
  expect(toggle.props["aria-expanded"]).toBe(false);
  (toggle.props.onClick as () => void)();
  view = render(read);
  expect(view.filter((node) => node.props.className === "c-chip")).toHaveLength(
    5,
  );
  expect(view.some((node) => node.props.children === items[4].uri)).toBe(true);
  (
    view.find((node) => node.props["aria-label"] === "移除 修改意见.md")?.props
      .onClick as (() => void) | undefined
  )?.();
  expect(items).toHaveLength(5);
  (
    view.find((node) => node.props.className === "x")!.props
      .onClick as () => void
  )();
  expect(remove).toHaveBeenCalledWith("0");
});
it("compares an extra option before calling the real config setter and keeps the confirmed value on failure", async () => {
  const thread = freshThreadState("config-redesign", "example", "/p", "s");
  thread.configOptions = [
    {
      id: "extra",
      name: "Extra",
      description: "Declared explanation",
      category: "vendor",
      type: "select",
      currentValue: "old",
      options: [
        { value: "old", name: "Old" },
        { value: "new", name: "New" },
      ],
    },
  ];
  const read = () => {
    const row = Children.toArray(
      SessionOptionsList({ thread }).props.children,
    )[0] as Element;
    return (row.type as (props: unknown) => ReactNode)(row.props);
  };
  const set = vi
    .spyOn(threads, "setConfig")
    .mockRejectedValue(new Error("failed"));
  let view = render(read);
  (
    view.find((node) => node.type === ModelPicker)!.props.onPick as (
      v: string,
    ) => void
  )("new");
  expect(set).not.toHaveBeenCalled();
  view = render(read);
  expect(view.some((node) => node.props.children === R.currentValue)).toBe(
    true,
  );
  (
    view.find((node) => node.props.children === R.optionApply)!.props
      .onClick as () => void
  )();
  await vi.waitFor(() =>
    expect(set).toHaveBeenCalledWith(thread.key, "extra", "new"),
  );
  expect(thread.configOptions[0].currentValue).toBe("old");
  await vi.waitFor(() =>
    expect(render(read).some((node) => node.props.role === "alert")).toBe(true),
  );
});
it("preserves the main draft and a separate resend editor when closing, with no implicit dispatch", () => {
  const thread = freshThreadState("resend-dialog", "example", "/p", "s");
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "Main draft",
    attachments: [],
  }));
  composerDrafts.update(`resend:${thread.key}`, () => ({
    text: "Edited reply",
    attachments: [],
  }));
  const main = composerDrafts.read(`session:${thread.key}`);
  const close = vi.fn();
  const send = vi.spyOn(threads, "send");
  const view = render(() =>
    MessageResendDialog({
      thread,
      imageEnabled: false,
      embedContext: false,
      continued: true,
      onClose: close,
      onGoSettings: vi.fn(),
    }),
  );
  expect(view.find((node) => node.type === Composer)?.props.draftKey).toBe(
    `resend:${thread.key}`,
  );
  (
    view.find((node) => node.props.children === R.resendKeep)!.props
      .onClick as () => void
  )();
  expect(composerDrafts.read(`session:${thread.key}`)).toBe(main);
  expect(composerDrafts.read(`resend:${thread.key}`).text).toBe("Edited reply");
  expect(send).not.toHaveBeenCalled();
  composerDrafts.update(`resend:${thread.key}`, (draft) => ({
    ...draft,
    sendPending: true,
  }));
  expect(configurationInputBusy(thread)).toBe(true);
  composerDrafts.clear(`session:${thread.key}`);
  composerDrafts.clear(`resend:${thread.key}`);
});

it("shows boolean options with their declared accessible names and keeps unknown types read-only", () => {
  const thread = freshThreadState("config-types", "example", "/p", "s");
  thread.configOptions = [
    {
      id: "flag",
      name: "Declared flag",
      type: "boolean",
      currentValue: false,
      options: [],
    },
  ];
  const read = () => {
    const row = Children.toArray(
      SessionOptionsList({ thread }).props.children,
    )[0] as Element;
    return (row.type as (props: unknown) => ReactNode)(row.props);
  };
  const toggle = render(read).find((node) => node.props.role === "switch")!;
  expect(toggle.props["aria-label"]).toBe("Declared flag");
  expect(toggle.props["aria-checked"]).toBe(false);
  thread.configOptions[0].type = "future-type";
  expect(render(read).some((node) => node.props.role === "switch")).toBe(false);
  expect(
    render(read).some((node) => node.props.children === R.optionReadOnly),
  ).toBe(true);
});

it("retains the preparation read gate inside the independent resend composer", async () => {
  const { preparationFor } = await import("../runtime/agent_preparation");
  const thread = freshThreadState(
    "resend-read-gate",
    "resend-read-gate",
    "/p",
    "s",
  );
  preparationFor(thread.agentId).requireExplicitRead(thread);
  const view = render(() =>
    MessageResendDialog({
      thread,
      imageEnabled: false,
      embedContext: false,
      continued: false,
      onClose: vi.fn(),
      onGoSettings: vi.fn(),
    }),
  );
  const composer = view.find((node) => node.type === Composer)!;
  expect(composer.props.disabled).toBe(true);
  expect(composer.props.prepareAction).toBeTypeOf("function");
});

it("keeps reasoning at its confirmed value until the explicit comparison is accepted", () => {
  const thread = freshThreadState("reasoning-review", "example", "/p", "s");
  thread.configOptions = [
    {
      id: "effort",
      name: "Depth",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];
  const change = vi.spyOn(threads, "setConfig");
  const read = () => ReasoningControl({ thread });
  let view = render(read);
  (
    view.find((node) => node.type === ModelPicker)!.props.onPick as (
      value: string,
    ) => void
  )("high");
  view = render(read);
  expect(change).not.toHaveBeenCalled();
  expect(thread.configOptions[0].currentValue).toBe("low");
  const review = view.find((node) => node.type === ConfigurationChangeReview)!;
  expect(review.props.value).toBe("high");
  (review.props.onCancel as () => void)();
  expect(
    render(read).some((node) => node.type === ConfigurationChangeReview),
  ).toBe(false);
  expect(change).not.toHaveBeenCalled();
});
