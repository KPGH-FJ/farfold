import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
const h = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: unknown[] }[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = h.cursor++;
    const slot = (h.slots[i] ??= {
      value:
        typeof initial === "function" ? (initial as () => unknown)() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value =
          typeof next === "function"
            ? (next as (v: unknown) => unknown)(slot.value)
            : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = h.cursor++;
    const slot = (h.slots[i] ??= { value: { current: initial } });
    return slot.value;
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    const i = h.cursor++;
    const slot = h.slots[i];
    if (
      !slot ||
      deps.some((value, index) => !Object.is(value, slot.deps?.[index]))
    )
      h.effects.push(effect);
    h.slots[i] = { deps };
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
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
import { threads } from "../runtime/sessions";
import { invoke } from "@tauri-apps/api/core";
import { STRINGS } from "../runtime/strings";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";

function render(props: ComponentProps<typeof Composer>) {
  h.cursor = 0;
  let tree = Composer(props);
  for (const effect of h.effects.splice(0)) effect();
  h.cursor = 0;
  tree = Composer(props);
  const elements: ReactElement<Record<string, unknown>>[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
beforeEach(() => {
  h.slots.length = 0;
  h.effects.length = 0;
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  composerDrafts.update("new", () => ({
    text: "first message",
    attachments: [],
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
});

it("omits only the failed-open reason already presented by the conversation", () => {
  const thread = freshThreadState("a:/p:notice", "a", "/p", "notice");
  thread.openError = STRINGS.repair.reconnectFailed;
  thread.configError = "Configuration needs another attempt";
  const elements = render({
    thread,
    imageEnabled: false,
    onGoSettings: vi.fn(),
    suppressThreadOpenError: true,
  });
  expect(elements.some((e) => e.props.children === thread.openError)).toBe(
    false,
  );
  expect(elements.some((e) => e.props.children === thread.configError)).toBe(
    true,
  );
  expect(
    elements.some((e) => e.type === "button" && e.props.children === "去设置"),
  ).toBe(false);
});

it.each([false, true])(
  "does not attach a hidden open error's settings action to the permission notice (parent presents it: %s)",
  (suppressThreadOpenError) => {
    const thread = freshThreadState(
      "a:/p:permission-notice",
      "a",
      "/p",
      "permission-notice",
    );
    thread.openError = STRINGS.repair.reconnectFailed;
    thread.permissionConfigId = "permissions";
    thread.permissionState = "unknown";
    const elements = render({
      thread,
      imageEnabled: false,
      onGoSettings: vi.fn(),
      suppressThreadOpenError,
      note: "Start setup error",
      noteAction: true,
    });
    expect(
      elements.some((e) => e.props.children === C.permissionUnknownNote),
    ).toBe(true);
    expect(
      elements.some(
        (e) => e.type === "button" && e.props.children === "去设置",
      ),
    ).toBe(false);
  },
);

it("retains the independent composer's failed-open action and the Start page's explicit setup action", () => {
  const thread = freshThreadState("a:/p:standalone", "a", "/p", "standalone");
  thread.openError = STRINGS.repair.reconnectFailed;
  for (const props of [
    { thread, imageEnabled: false, onGoSettings: vi.fn() },
    {
      thread: null,
      imageEnabled: false,
      onGoSettings: vi.fn(),
      note: "Start setup error",
      noteAction: true,
    },
  ]) {
    const elements = render(props);
    const button = elements.find(
      (e) => e.type === "button" && e.props.children === "去设置",
    )!;
    expect(button).toBeDefined();
    (button.props.onClick as () => void)();
    expect(props.onGoSettings).toHaveBeenCalledExactlyOnceWith();
  }
});

it.each([
  "此消息发送失败，请重试",
  "附件已无法读取，请重新选择或移除后再发送。",
])(
  "keeps first-send failure %s without routing to unrelated setup, until an explicit context switch",
  async (rejected) => {
    const onSend = vi.fn(async () => {
      throw new Error(rejected);
    });
    const props: ComponentProps<typeof Composer> = {
      thread: freshThreadState("a:/p:prepared", "a", "/p", "prepared"),
      imageEnabled: false,
      onGoSettings: () => {},
      draftKey: "new",
      errorContextKey: "a:/p",
      onSend,
    };
    const send = render(props).find(
      (e) => e.type === "button" && e.props["aria-label"] === "发送",
    )!;
    expect(send.props.disabled).toBe(false);
    (send.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(render(props).some((e) => e.props.children === rejected)).toBe(
        true,
      ),
    );
    expect(
      render(props).some(
        (e) => e.type === "button" && e.props.children === "去设置",
      ),
    ).toBe(false);
    expect(
      render({ ...props, thread: null }).some(
        (e) => e.props.children === rejected,
      ),
    ).toBe(true);
    expect(
      render({
        ...props,
        thread: freshThreadState(
          "a:/p:prepared-again",
          "a",
          "/p",
          "prepared-again",
        ),
      }).some((e) => e.props.children === rejected),
    ).toBe(true);
    expect(
      render({ ...props, errorContextKey: "other:/p", thread: null }).some(
        (e) => e.props.children === rejected,
      ),
    ).toBe(false);
    expect(composerDrafts.read("new").text).toBe("first message");
  },
);

it("allows stop retry after confirmation expires even while the first cancel call is unresolved", async () => {
  vi.useFakeTimers();
  const thread = threads.markOpenFailed(
    "a:/p:stop-pending-ipc",
    "a",
    "/p",
    "stop-pending-ipc",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  let finish!: () => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "session_cancel"
      ? new Promise<void>((resolve) => (finish = resolve))
      : Promise.resolve(null),
  );
  const props = { thread, imageEnabled: false, onGoSettings: () => {} };
  const clickStop = () => {
    const stop = render(props).find(
      (element) =>
        element.type === "button" &&
        String(element.props.className).includes("c-stop"),
    )!;
    (stop.props.onClick as () => void)();
  };
  clickStop();
  expect(thread.stopping).toBe(true);
  const firstFinish = finish;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(thread.stopUnconfirmed).toBe(true);
  clickStop();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "session_cancel"),
  ).toHaveLength(2);
  expect(thread.stopping).toBe(true);
  firstFinish();
  finish();
});

it.each(["stopping", "stopUnconfirmed", "connectionOutcomeUnknown"] as const)(
  "keeps the draft in the input and does not enqueue it while %s",
  async (status) => {
    const thread = freshThreadState(`a:/p:${status}`, "a", "/p", status);
    thread.running = status !== "connectionOutcomeUnknown";
    thread[status] = true;
    const send = vi
      .spyOn(threads, "send")
      .mockResolvedValue({ status: "accepted" });
    const props = {
      thread,
      draftKey: "new",
      imageEnabled: false,
      onGoSettings: () => {},
    };
    const input = render(props).find((element) => element.type === "textarea")!;
    expect(input.props.disabled).toBe(false);
    (input.props.onKeyDown as (event: unknown) => void)({
      key: "Enter",
      nativeEvent: { isComposing: false },
      preventDefault: () => {},
    });
    expect(draftPersistence.flush).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(composerDrafts.read("new").text).toBe("first message");
    expect(composerDrafts.read("new").sendPending).not.toBe(true);
  },
);

it("keeps stop ownership with each conversation when switching before a cancel reply", async () => {
  vi.useFakeTimers();
  const pending: (() => void)[] = [];
  vi.mocked(invoke).mockImplementation((command) =>
    command === "session_cancel"
      ? new Promise<void>((resolve) => pending.push(resolve))
      : Promise.resolve(null),
  );
  const states = ["stop-switch-a", "stop-switch-b"].map((id) => {
    const thread = threads.markOpenFailed(
      `a:/p:${id}`,
      "a",
      "/p",
      id,
      "fixture",
    );
    thread.openError = null;
    thread.running = true;
    return thread;
  });
  for (const thread of states) {
    const stop = render({
      thread,
      imageEnabled: false,
      onGoSettings: () => {},
    }).find(
      (element) =>
        element.type === "button" &&
        String(element.props.className).includes("c-stop"),
    )!;
    expect(stop.props.disabled).toBe(false);
    (stop.props.onClick as () => void)();
  }
  const calls = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "session_cancel");
  expect(
    calls.map(([, args]) => (args as { sessionId: string }).sessionId),
  ).toEqual(["stop-switch-a", "stop-switch-b"]);
  expect(states.every((thread) => thread.stopping)).toBe(true);
  pending.forEach((finish) => finish());
});
