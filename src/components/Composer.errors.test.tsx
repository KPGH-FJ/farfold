// These existing hook fixtures have no native browser; the barrier has dedicated lifecycle tests.
vi.mock("../runtime/browser_surface", async (original) => ({
  ...(await original<typeof import("../runtime/browser_surface")>()),
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));
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
// These pre-existing error/retry scenarios have no associated worktree.
// Keep the real notice renderer, without starting catalogue IPC from this hook fixture.
vi.mock("../runtime/worktrees", () => {
  const empty = {
    ready: true,
    loading: false,
    error: null,
    archives: [],
    recoveries: [],
  };
  return {
    worktrees: {
      snapshot: () => empty,
      subscribe: () => () => {},
      load: vi.fn(),
    },
  };
});
import { Composer } from "./Composer";
import { ComposerWorkNotice } from "./ComposerWorkNotice";
import { ErrorNotice } from "./ErrorNotice";
import { ArchivedWorkLocationNotice } from "./ArchivedWorkLocationNotice";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { freshThreadState } from "../runtime/session_projection";
import { threads } from "../runtime/sessions";
import { invoke } from "@tauri-apps/api/core";
import { STRINGS } from "../runtime/strings";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { applyConfigCheck } from "../runtime/config_check";

let noticeSlots: typeof h.slots = [];
function renderArchivedNotice(
  props: ComponentProps<typeof ArchivedWorkLocationNotice>,
) {
  const parent = { slots: h.slots, cursor: h.cursor, effects: h.effects };
  h.slots = noticeSlots;
  h.cursor = 0;
  h.effects = [];
  try {
    return ArchivedWorkLocationNotice(props);
  } finally {
    noticeSlots = h.slots;
    // Child effects/lifetime are covered by dedicated notice tests, not this parent fixture.
    Object.assign(h, parent);
  }
}
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
      if (child.type === ComposerWorkNotice)
        visit(
          ComposerWorkNotice(
            child.props as ComponentProps<typeof ComposerWorkNotice>,
          ),
        );
      else if (child.type === ArchivedWorkLocationNotice)
        visit(
          renderArchivedNotice(
            child.props as ComponentProps<typeof ArchivedWorkLocationNotice>,
          ),
        );
      else visit(child.props.children as ReactNode);
    });
  visit(tree);
  return elements;
}
beforeEach(() => {
  noticeSlots = [];
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
  expect(
    elements.some(
      (e) => e.type === ErrorNotice && e.props.message === thread.openError,
    ),
  ).toBe(false);
  expect(
    elements.some(
      (e) => e.type === ErrorNotice && e.props.message === thread.configError,
    ),
  ).toBe(true);
  expect(
    elements.some((e) => e.type === "button" && e.props.children === "去设置"),
  ).toBe(false);
});

it("renders an unknown configuration neutrally while preserving its actual input guard", () => {
  const thread = freshThreadState(
    "a:/p:config-unknown",
    "a",
    "/p",
    "config-unknown",
  );
  thread.identity = "established";
  thread.configOptions = [
    {
      id: "model",
      category: "model",
      name: "Model",
      type: "select",
      currentValue: "kept-model",
      options: [{ value: "kept-model", name: "Kept Model Label" }],
    },
  ];
  const queued = (thread.queued = [
    [{ type: "text", text: "kept queued input" }],
  ]);
  const options = thread.configOptions;
  applyConfigCheck(thread, {
    status: "blocked",
    issues: [
      { category: "model", reason: "unknown", expected: null, current: null },
    ],
    current: {
      choices: [
        { id: "model", category: "model", type: "select", value: "kept-model" },
      ],
    },
  });
  const send = vi.spyOn(threads, "send");
  const elements = render({
    thread,
    draftKey: "new",
    imageEnabled: false,
    onGoSettings: () => {},
  });
  const notice = elements.find((e) => e.type === ErrorNotice)!;
  expect(notice.props.message).toContain("设置尚未确认");
  expect(notice.props.message).toContain(STRINGS.repair.configBlocked);
  expect(notice.props.message).not.toContain("→");
  expect(notice.props.message).not.toContain(STRINGS.repair.unknownModel);
  expect(notice.props.message).not.toContain("Kept Model Label");
  const submit = elements.find(
    (e) =>
      e.type === "button" && String(e.props.className).startsWith("c-send"),
  )!;
  expect(submit.props.disabled).toBe(true);
  expect(thread.configOptions).toBe(options);
  expect(thread.configOptions[0].currentValue).toBe("kept-model");
  expect(thread.modelDrift).toBe(true);
  expect(thread.queuePaused).toBe("unavailable");
  expect(thread.queued).toBe(queued);
  expect(composerDrafts.read("new").text).toBe("first message");
  expect(send).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
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
      elements.some(
        (e) =>
          e.type === ErrorNotice && e.props.message === C.permissionUnknownNote,
      ),
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
    const shown = (elements: ReturnType<typeof render>) =>
      elements.some(
        (e) => e.type === ErrorNotice && e.props.message === rejected,
      );
    await vi.waitFor(() => expect(shown(render(props))).toBe(true));
    expect(
      render(props).some(
        (e) => e.type === "button" && e.props.children === "去设置",
      ),
    ).toBe(false);
    expect(shown(render({ ...props, thread: null }))).toBe(true);
    expect(
      shown(
        render({
          ...props,
          thread: freshThreadState(
            "a:/p:prepared-again",
            "a",
            "/p",
            "prepared-again",
          ),
        }),
      ),
    ).toBe(true);
    expect(
      shown(render({ ...props, errorContextKey: "other:/p", thread: null })),
    ).toBe(false);
    expect(composerDrafts.read("new").text).toBe("first message");
  },
);

it.each([false, true])(
  "rechecks a chosen file before sending and keeps its draft after a failed check (embed: %s)",
  async (embedContext) => {
    composerDrafts.update("new", () => ({
      text: "read my selected file",
      attachments: [
        {
          id: "chosen-file",
          kind: "file",
          name: "附件 space%测试.txt",
          uri: "file:///chosen/%E9%99%84%E4%BB%B6%20space%25%E6%B5%8B%E8%AF%95.txt",
          content: "cached contents must not bypass the new read",
        },
      ],
    }));
    const original = composerDrafts.read("new");
    vi.mocked(invoke).mockRejectedValueOnce("current file read failed");
    const onSend = vi.fn();
    const props = {
      thread: null,
      draftKey: "new",
      imageEnabled: false,
      embedContext,
      onGoSettings() {},
      onSend,
    };
    const send = render(props).find(
      (element) => element.props["aria-label"] === STRINGS.composer.sendTitle,
    )!;
    await (send.props.onClick as () => Promise<void>)();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("draft_attachment_check", {
      uri: original.attachments[0]!.uri,
      embed: embedContext,
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
    expect(composerDrafts.read("new").sendPending).not.toBe(true);
  },
);

it("does not submit an attachment read after its exact draft has changed", async () => {
  composerDrafts.update("new", () => ({
    text: "original input",
    attachments: [
      { id: "file", kind: "file", name: "note.txt", uri: "file:///note.txt" },
    ],
  }));
  let finish!: (value: string) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () => new Promise<string>((resolve) => (finish = resolve)),
  );
  const onSend = vi.fn();
  const send = render({
    thread: null,
    draftKey: "new",
    imageEnabled: false,
    embedContext: true,
    onGoSettings() {},
    onSend,
  }).find(
    (element) => element.props["aria-label"] === STRINGS.composer.sendTitle,
  )!;
  const sending = (send.props.onClick as () => Promise<void>)();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "revised input",
  }));
  const revised = composerDrafts.read("new");
  finish("current file contents");
  await sending;
  expect(onSend).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(revised);
  expect(revised.attachments).toHaveLength(1);
});

it.each(["pptx", "pdf", "xlsx", "docx"])(
  "keeps the entire four-file draft and never calls onSend when the %s preparation rejects unsupported text",
  async (first) => {
    const extensions = [
      first,
      ...["pptx", "pdf", "xlsx", "docx"].filter((item) => item !== first),
    ];
    composerDrafts.update("new", () => ({
      text: "Only ACK; do not use tools",
      attachments: extensions.map((extension) => ({
        id: extension,
        kind: "file" as const,
        name: `owned.${extension}`,
        uri: `file:///private/owned-fixtures/owned.${extension}`,
      })),
    }));
    const original = composerDrafts.read("new");
    vi.mocked(invoke).mockRejectedValueOnce({ code: "unsupportedText" });
    const onSend = vi.fn();
    const props = {
      thread: null,
      draftKey: "new",
      imageEnabled: false,
      embedContext: true,
      onGoSettings() {},
      onSend,
    };
    const send = render(props).find(
      (element) => element.props["aria-label"] === STRINGS.composer.sendTitle,
    )!;
    await (send.props.onClick as () => Promise<void>)();
    expect(onSend).not.toHaveBeenCalled();
    expect(composerDrafts.read("new")).toBe(original);
    expect(original.attachments).toHaveLength(4);
    expect(original.sendPending).not.toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("draft_attachment_check", {
      uri: original.attachments[0].uri,
      embed: true,
    });
    await vi.waitFor(() =>
      expect(
        render(props).some((element) => element.type === ErrorNotice),
      ).toBe(true),
    );
    const notice = render(props).find(
      (element) => element.type === ErrorNotice,
    )!;
    expect(notice.props.message).toContain("不能直接作为文字发送");
    expect(String(notice.props.message).includes("加入文字")).toBe(
      first !== "pptx",
    );
    expect(notice.props.detail).toBeUndefined();
  },
);

it("retains an explicit text draft after capability loss and never calls onSend or reads its file", async () => {
  composerDrafts.update("new", () => ({
    text: "keep text",
    attachments: [
      {
        id: "text",
        kind: "file",
        name: "notes.txt",
        uri: "file:///owned/notes.txt",
        deliveryMode: "text",
        content: "previous text",
      },
    ],
  }));
  const original = composerDrafts.read("new");
  const onSend = vi.fn();
  const props = {
    thread: null,
    draftKey: "new",
    imageEnabled: false,
    embedContext: false,
    onGoSettings() {},
    onSend,
  };
  const send = render(props).find(
    (element) => element.props["aria-label"] === STRINGS.composer.sendTitle,
  )!;
  await (send.props.onClick as () => Promise<void>)();
  await vi.waitFor(() =>
    expect(
      render(props).some(
        (element) =>
          element.type === ErrorNotice &&
          String(element.props.message).includes("不支持接收附件文字"),
      ),
    ).toBe(true),
  );
  expect(onSend).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
  expect(composerDrafts.read("new")).toBe(original);
  expect(original.sendPending).not.toBe(true);
});

it("passes four explicitly located files to onSend as links without trying text conversion", async () => {
  const extensions = ["pptx", "pdf", "xlsx", "docx"];
  composerDrafts.update("new", () => ({
    text: "only ACK",
    attachments: extensions.map((extension) => ({
      id: extension,
      kind: "file",
      name: `owned.${extension}`,
      uri: `file:///owned/owned.${extension}`,
      deliveryMode: "location",
    })),
  }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (
      command === "draft_attachment_check" &&
      (args as { embed: boolean }).embed
    )
      throw { code: "unsupportedText" };
    return null;
  });
  const onSend = vi.fn().mockResolvedValue(false);
  const props = {
    thread: null,
    draftKey: "new",
    imageEnabled: false,
    embedContext: true,
    onGoSettings() {},
    onSend,
  };
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  try {
    const send = render(props).find(
      (element) => element.props["aria-label"] === STRINGS.composer.sendTitle,
    )!;
    await (send.props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toEqual([
      { type: "text", text: "only ACK" },
      ...extensions.map((extension) => ({
        type: "resource_link",
        name: `owned.${extension}`,
        uri: `file:///owned/owned.${extension}`,
      })),
    ]);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(
          ([command, args]) =>
            command === "draft_attachment_check" &&
            (args as { embed: boolean }).embed === false,
        ),
    ).toBe(true);
    expect(composerDrafts.read("new").attachments).toHaveLength(4);
  } finally {
    vi.unstubAllGlobals();
  }
});

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
