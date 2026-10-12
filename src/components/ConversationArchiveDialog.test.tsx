import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  effects: [] as { deps: unknown[]; close?: () => void }[],
  cursor: 0,
  ref: 0,
  effect: 0,
  pick: vi.fn(),
  open: vi.fn(),
  begin: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    if (i >= h.states.length)
      h.states.push(typeof initial === "function" ? initial() : initial);
    return [
      h.states[i],
      (v: unknown) => {
        h.states[i] = typeof v === "function" ? v(h.states[i]) : v;
      },
    ];
  },
  useRef: (current: unknown) => (h.refs[h.ref++] ??= { current }),
  useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
    const i = h.effect++;
    if (!h.effects[i] || deps.some((x, j) => x !== h.effects[i].deps[j])) {
      h.effects[i]?.close?.();
      h.effects[i] = { deps, close: fn() || undefined };
    }
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: h.pick, open: h.open }));
vi.mock("../runtime/conversation_archive_jobs", () => ({
  conversationArchiveJobs: { begin: h.begin },
  useConversationArchiveJobs: () => [],
}));
import { ConversationArchiveDialog } from "./ConversationArchiveDialog";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { ARCHIVE_STRINGS as S } from "../runtime/conversation_archive_strings";
import { captureConversationExport } from "../runtime/conversation_archive_snapshot";
const capture = () =>
  captureConversationExport(
    {
      cwd: "/owned",
      items: [
        {
          kind: "user",
          id: "u",
          text: "original content",
          attachments: [],
          streaming: false,
          time: 1,
        },
      ],
    },
    "test",
    "Agent",
  );
let c = capture();
const close = vi.fn();
const registered = vi.fn();
const render = () => {
  h.cursor = h.ref = h.effect = 0;
  return ConversationArchiveDialog({
    capture: c,
    name: "conversation.md",
    includeDetails: false,
    onClose: close,
    returnFocusRef: { current: null },
    formatControls: () => null,
    onRegistered: registered,
  });
};
function nodes(
  node: ReactNode = render(),
): { type: unknown; props: Record<string, unknown> }[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [
          { type: child.type, props: child.props },
          ...(child.props.children === undefined
            ? []
            : nodes(child.props.children as ReactNode)),
        ]
      : [],
  );
}
const click = (label: string) => {
  const node = nodes().find(
    (n) => n.type === "button" && n.props.children === label,
  )!;
  (node.props.onClick as () => void)();
};
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};
beforeEach(() => {
  h.states = [];
  h.refs = [];
  h.effects = [];
  h.pick.mockReset();
  h.open.mockReset();
  h.begin.mockReset().mockReturnValue("job");
  c = capture();
  close.mockReset();
  registered.mockReset();
});
afterEach(() => {
  h.effects.forEach((e) => e.close?.());
  vi.restoreAllMocks();
});
it("close before a late chooser reply prevents hashing/registration and never begins a save", async () => {
  let reply: (s: string) => void = () => {};
  h.pick.mockImplementation(() => new Promise((r) => (reply = r)));
  click(S.save);
  click(S.save);
  expect(h.pick).toHaveBeenCalledOnce();
  (
    nodes().find((n) => n.type === WorkspaceDialog)!.props.onClose as () => void
  )();
  reply("/owned/out.zip");
  await flush();
  expect(close).toHaveBeenCalledOnce();
  expect(h.begin).not.toHaveBeenCalled();
});
it("unmount while input hashing is pending retires the exact view even if reopened with the same capture", async () => {
  h.pick.mockResolvedValue("/owned/out.zip");
  let finish: (v: ArrayBuffer) => void = () => {};
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    () => new Promise((r) => (finish = r)),
  );
  click(S.save);
  await flush();
  h.effects.forEach((e) => e.close?.());
  h.effects = [];
  render();
  finish(new ArrayBuffer(32));
  await flush();
  expect(h.begin).not.toHaveBeenCalled();
});
it("after synchronous intent registration close only hides and retains the saving activity", async () => {
  h.pick.mockResolvedValue("/owned/out.zip");
  click(S.save);
  await flush();
  expect(h.begin).toHaveBeenCalledOnce();
  expect(registered).toHaveBeenCalledOnce();
  expect(
    (h.states[0] as { getSnapshot: () => unknown[] }).getSnapshot(),
  ).toEqual([]);
  expect(h.begin.mock.calls[0][0]).toMatchObject({
    destination: "/owned/out.zip",
    selected: [],
  });
  expect(nodes().some((n) => n.props.children === S.closeScope)).toBe(true);
  click(S.continue);
  expect(close).toHaveBeenCalledOnce();
  expect(h.begin).toHaveBeenCalledOnce();
});
it("cancelled chooser keeps original capture without fabricating a saved result", async () => {
  h.pick.mockResolvedValue(null);
  click(S.save);
  await flush();
  expect(h.begin).not.toHaveBeenCalled();
  expect(nodes().some((n) => n.props.children === S.pickerCancelled)).toBe(
    true,
  );
});
