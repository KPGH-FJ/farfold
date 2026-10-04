import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
  useMemo: (read: () => unknown) => read(),
  useEffect: () => {},
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
// These tests invoke ThreadView with a minimal hook harness; browser permissions
// have their own controller/component tests and are absent from these scenarios.
vi.mock("../runtime/browser_sharing", async (original) => {
  const actual = await original<typeof import("../runtime/browser_sharing")>();
  const noop = async () => {};
  const empty: import("../runtime/browser_sharing").BrowserSharingModel = {
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: noop,
    allow: noop,
    stop: noop,
    respond: noop,
  };
  return { ...actual, useBrowserSharing: () => empty };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import {
  threads,
  freshThreadState,
  type ThreadState,
} from "../runtime/sessions";
import { preparationFor } from "../runtime/agent_preparation";
import { STRINGS } from "../runtime/strings";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";

type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function view(thread: ThreadState, onGoSettings = vi.fn()) {
  return nodes(
    ThreadView({
      thread,
      active: true,
      agents: [],
      onGoSettings,
      onOpened: vi.fn(),
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

it("routes a stale recovery-failure new-draft action to preparation without opening another conversation", () => {
  const thread = freshThreadState(
    "recovery-return",
    "recovery-return",
    "/original",
    "old",
  );
  thread.identity = "established";
  thread.unrecoverable = true;
  const onGoSettings = vi.fn();
  const action = view(thread, onGoSettings).find(
    (node) => node.props.children === STRINGS.repair.newDraft,
  )!;
  const create = vi
    .spyOn(threads, "newAfterRecoveryFailure")
    .mockResolvedValue(thread);
  preparationFor(thread.agentId).requireExplicitRead(thread);
  (action.props.onClick as () => void)();
  expect(create).not.toHaveBeenCalled();
  expect(onGoSettings).toHaveBeenCalledOnce();
  expect(
    view(thread).some((node) => node.props.children === C.readRequired),
  ).toBe(true);
  expect(thread.identity).toBe("established");
});

it("blocks an already opened draft at the actual send callback and preserves its selection", async () => {
  const thread = freshThreadState(
    "draft-return",
    "draft-return",
    "/original",
    "draft",
  );
  thread.identity = "draft";
  thread.configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "original",
      options: [],
    },
  ];
  const onGoSettings = vi.fn();
  const send = vi.spyOn(threads, "send");
  const composer = view(thread, onGoSettings).find(
    (node) => node.type === Composer,
  )!;
  preparationFor(thread.agentId).requireExplicitRead(thread);
  expect(composer.props.onSend).toBeTypeOf("function");
  await expect(
    (composer.props.onSend as (blocks: unknown[]) => Promise<void>)([]),
  ).rejects.toThrow(C.readRequired);
  const blocked = view(thread, onGoSettings).find(
    (node) => node.type === Composer,
  )!;
  expect(blocked.props.disabled).toBe(true);
  (blocked.props.prepareAction as () => void)();
  expect(onGoSettings).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(thread.configOptions[0].currentValue).toBe("original");
});

it.each(["existing-conversation", "other-directory", "api-source"])(
  "keeps the existing conversation and unrelated draft boundaries (%s)",
  async (kind) => {
    const thread = freshThreadState(kind, kind, "/original", kind);
    thread.identity =
      kind === "existing-conversation" ? "established" : "draft";
    preparationFor(thread.agentId).requireExplicitRead(thread);
    if (kind === "other-directory") thread.cwd = "/elsewhere";
    if (kind === "api-source")
      thread.service = { id: "api", model: "chosen", fingerprint: "fixture" };
    const composer = view(thread).find((node) => node.type === Composer)!;
    expect(composer.props.disabled).not.toBe(true);
    expect(composer.props.prepareAction).toBeUndefined();
    if (kind === "existing-conversation")
      expect(composer.props.onSend).toBeUndefined();
    else {
      const send = vi
        .spyOn(threads, "send")
        .mockResolvedValue({ status: "accepted" });
      await (composer.props.onSend as (blocks: unknown[]) => Promise<void>)([]);
      expect(send).toHaveBeenCalledWith(thread.key, []);
    }
  },
);
