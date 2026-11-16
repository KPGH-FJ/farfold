import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

type Slot = {
  value?: unknown;
  deps?: readonly unknown[];
  cleanup?: () => void;
};
type Lifetime = {
  slots: Slot[];
  cursor: number;
  effects: { slot: Slot; run: () => unknown }[];
};
const h = vi.hoisted(() => ({
  current: null as Lifetime | null,
  notices: [] as unknown[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const life = h.current!;
    const slot = (life.slots[life.cursor++] ??= {
      value: typeof initial === "function" ? initial() : initial,
    });
    return [
      slot.value,
      (next: unknown) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const life = h.current!;
    return (life.slots[life.cursor++] ??= { value: { current: initial } })
      .value;
  },
  useEffect: (run: () => unknown, deps?: readonly unknown[]) => {
    const life = h.current!;
    const index = life.cursor++;
    const previous = life.slots[index];
    if (
      !previous ||
      !deps ||
      deps.some((value, i) => !Object.is(value, previous.deps?.[i]))
    ) {
      const slot = { deps, cleanup: previous?.cleanup };
      life.slots[index] = slot;
      life.effects.push({ slot, run });
    }
  },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("../runtime/browser_surface", () => ({
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
vi.mock("./useComposerFileDrop", () => ({
  useComposerFileDrop: () => ({ over: false, error: null }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/ui_error", async (original) => {
  const actual = await original<typeof import("../runtime/ui_error")>();
  return {
    ...actual,
    toUiNotice: (...args: Parameters<typeof actual.toUiNotice>) => {
      // Observe the real catch after its cleanup. Keep actual feedback mapping.
      h.notices.push(args[0]);
      return actual.toUiNotice(...args);
    },
  };
});
import { invoke } from "@tauri-apps/api/core";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { DRAFT_STRINGS } from "../runtime/draft_storage";
import { DraftAttachmentCheckError } from "../runtime/draft_attachments";
import { freshThreadState } from "../runtime/session_projection";
import { STRINGS } from "../runtime/strings";
import { Composer } from "./Composer";

const mounts: { unmount: () => void }[] = [];
const keys = new Set<string>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function conversation(id: string) {
  const thread = freshThreadState(
    `owner:/fixture:${id}`,
    "owner",
    "/fixture",
    id,
  );
  thread.identity = "established";
  thread.openError = null;
  keys.add(`session:${thread.key}`);
  return thread;
}

// Existing ordinary routes without browser/prepared ownership unmount on
// navigation (App.tsx). Keep separate hook lifetimes and run real cleanup; the
// draft store, attachment preparation and Composer send callback remain real.
function mount(props: ComponentProps<typeof Composer>) {
  const life: Lifetime = { slots: [], cursor: 0, effects: [] };
  const render = () => {
    h.current = life;
    life.cursor = 0;
    let tree = Composer(props);
    for (const effect of life.effects.splice(0)) {
      effect.slot.cleanup?.();
      const cleanup = effect.run();
      effect.slot.cleanup =
        typeof cleanup === "function" ? (cleanup as () => void) : undefined;
    }
    life.cursor = 0;
    tree = Composer(props);
    h.current = null;
    const elements: ReactElement<Record<string, unknown>>[] = [];
    const visit = (node: ReactNode) =>
      Children.forEach(node, (child) => {
        if (!isValidElement<Record<string, unknown>>(child)) return;
        elements.push(child);
        visit(child.props.children as ReactNode);
      });
    visit(tree);
    return elements;
  };
  const instance = {
    render,
    send() {
      const button = render().find(
        (node) => node.props["aria-label"] === STRINGS.composer.sendTitle,
      )!;
      expect(button.props.disabled).toBe(false);
      (button.props.onClick as () => void)();
    },
    unmount() {
      for (const slot of life.slots) {
        slot.cleanup?.();
        slot.cleanup = undefined;
      }
    },
  };
  mounts.push(instance);
  return instance;
}

beforeEach(() => {
  h.notices.length = 0;
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(draftPersistence, "snapshot").mockReturnValue({
    ready: true,
    saving: false,
    error: null,
  });
  vi.mocked(invoke).mockReset();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
});
afterEach(() => {
  mounts.splice(0).forEach((instance) => instance.unmount());
  keys.forEach((key) => composerDrafts.clear(key));
  keys.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("an unmounted old attachment failure cannot release a remounted newer send or retain its already accepted text", async () => {
  const thread = conversation("remounted"),
    key = `session:${thread.key}`;
  const oldRead = deferred<null>(),
    admission = deferred<boolean>();
  const oldFailure = Object.freeze({ code: "unreadable" });
  const onSend = vi.fn<NonNullable<ComponentProps<typeof Composer>["onSend"]>>(
    () => admission.promise,
  );
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    if (command === "settings_get") return null;
    expect(command).toBe("draft_attachment_check");
    return (input as { uri: string }).uri === "file:///fixture/old.txt"
      ? oldRead.promise
      : null;
  });
  const props = {
    thread,
    imageEnabled: false,
    embedContext: false,
    onGoSettings() {},
    onSend,
  };
  composerDrafts.update(key, () => ({
    text: "old text",
    attachments: [
      {
        id: "old",
        kind: "file",
        name: "old.txt",
        uri: "file:///fixture/old.txt",
      },
    ],
  }));
  const old = mount(props);
  old.send();
  await vi.waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "draft_attachment_check"),
    ).toHaveLength(1),
  );
  old.unmount();
  const away = mount({ ...props, thread: conversation("away") });
  away.unmount();
  const newAttachment = {
    id: "new",
    kind: "file" as const,
    name: "new.txt",
    uri: "file:///fixture/new.txt",
  };
  composerDrafts.update(key, () => ({
    text: "new explicit input",
    attachments: [newAttachment],
  }));
  const current = mount(props);
  current.send();
  await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  const owned = composerDrafts.read(key);
  expect(owned.sendPending).toBe(true);
  expect(onSend.mock.calls[0]![1]).toBe(owned);
  oldRead.reject(oldFailure);
  await vi.waitFor(() =>
    expect(
      h.notices.some((error) => error instanceof DraftAttachmentCheckError),
    ).toBe(true),
  );
  const afterOldFailure = composerDrafts.read(key);
  expect(afterOldFailure.text).toBe("new explicit input");
  expect(afterOldFailure.attachments).toEqual([newAttachment]);
  admission.resolve(true);
  await vi.waitFor(() =>
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1),
  );
  console.info(
    "COMPOSER_SEND_OWNER_OBSERVATION",
    JSON.stringify({
      oldNativeFailure: oldFailure,
      sameNewSnapshotAfterOldFailure: afterOldFailure === owned,
      pendingAfterOldFailure: afterOldFailure.sendPending,
      textAfterNewAccepted: composerDrafts.read(key).text,
      actualOnSendCalls: onSend.mock.calls.length,
    }),
  );
  expect.soft(afterOldFailure).toBe(owned);
  expect.soft(afterOldFailure.sendPending).toBe(true);
  expect(composerDrafts.hasContent(key)).toBe(false);
});

it("its own failed send releases its pending flag while preserving later text and attachments", async () => {
  const thread = conversation("own-failure"),
    key = `session:${thread.key}`;
  const admission = deferred<boolean>();
  const failure = new Error("controlled own submission failure");
  const onSend = vi.fn<NonNullable<ComponentProps<typeof Composer>["onSend"]>>(
    () => admission.promise,
  );
  const attachment = {
    id: "kept",
    kind: "file" as const,
    name: "keep.txt",
    uri: "file:///fixture/keep.txt",
  };
  vi.mocked(invoke).mockResolvedValue(null);
  composerDrafts.update(key, () => ({
    text: "initial",
    attachments: [attachment],
  }));
  const current = mount({
    thread,
    imageEnabled: false,
    embedContext: false,
    onGoSettings() {},
    onSend,
  });
  current.send();
  await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  composerDrafts.update(key, (draft) => ({
    ...draft,
    text: "later local text",
  }));
  admission.reject(failure);
  await vi.waitFor(() => expect(h.notices).toContain(failure));
  expect(composerDrafts.read(key)).toMatchObject({
    text: "later local text",
    attachments: [attachment],
    sendPending: false,
  });
  expect(onSend).toHaveBeenCalledTimes(1);
});

it.each(["accepted", "rejected"] as const)(
  "a previously pending send's late %s result cannot release a replacement send after explicit review",
  async (outcome) => {
    const thread = conversation(`late-${outcome}`),
      key = `session:${thread.key}`;
    const oldAdmission = deferred<boolean>(),
      newAdmission = deferred<boolean>();
    const oldFailure = new Error("controlled old admission failure");
    const onSend = vi
      .fn<NonNullable<ComponentProps<typeof Composer>["onSend"]>>()
      .mockImplementationOnce(() => oldAdmission.promise)
      .mockImplementationOnce(() => newAdmission.promise);
    vi.mocked(invoke).mockResolvedValue(null);
    composerDrafts.update(key, () => ({
      text: "first explicit input",
      attachments: [],
    }));
    const props = {
      thread,
      imageEnabled: false,
      embedContext: false,
      onGoSettings() {},
      onSend,
    };
    const original = mount(props);
    original.send();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(composerDrafts.read(key).sendPending).toBe(true);
    original.unmount();
    const away = mount({ ...props, thread: conversation(`away-${outcome}`) });
    away.unmount();
    const current = mount(props);
    const reviewed = current
      .render()
      .find((node) => node.props.children === DRAFT_STRINGS.reviewed)!;
    expect(reviewed).toBeDefined();
    (reviewed.props.onClick as () => void)();
    expect(composerDrafts.read(key).sendPending).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
    const attachment = {
      id: "replacement",
      kind: "file" as const,
      name: "replacement.txt",
      uri: "file:///fixture/replacement.txt",
    };
    composerDrafts.update(key, (draft) => ({
      ...draft,
      text: "replacement explicit input",
      attachments: [attachment],
    }));
    current.send();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    const owned = composerDrafts.read(key);
    expect(onSend.mock.calls[1]![1]).toBe(owned);
    expect(owned.sendPending).toBe(true);
    if (outcome === "accepted") {
      oldAdmission.resolve(true);
      await vi.waitFor(() =>
        expect(requestAnimationFrame).toHaveBeenCalledTimes(1),
      );
    } else {
      oldAdmission.reject(oldFailure);
      await vi.waitFor(() => expect(h.notices).toContain(oldFailure));
    }
    const afterOld = composerDrafts.read(key);
    newAdmission.resolve(true);
    await vi.waitFor(() =>
      expect(requestAnimationFrame).toHaveBeenCalledTimes(
        outcome === "accepted" ? 2 : 1,
      ),
    );
    expect(afterOld).toBe(owned);
    expect(afterOld.sendPending).toBe(true);
    expect(afterOld.attachments).toEqual([attachment]);
    expect(afterOld.text).toBe("replacement explicit input");
    expect(composerDrafts.hasContent(key)).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(2);
  },
);
