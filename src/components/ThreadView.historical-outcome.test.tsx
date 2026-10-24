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
// No browser state or permission participates in this notice-only fixture.
vi.mock("../runtime/browser_sharing", async (original) => ({
  ...(await original<typeof import("../runtime/browser_sharing")>()),
  useBrowserSharing: () => ({
    info: null,
    pendingRequest: null,
    operation: null,
    error: "",
    notice: "",
    ready: false,
    queryState: "no_session",
    refresh: async () => {},
    allow: async () => {},
    stop: async () => {},
    respond: async () => {},
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));

import { ThreadView } from "./ThreadView";
import {
  threads,
  freshThreadState,
  type ThreadState,
} from "../runtime/sessions";
import { draftPersistence, draftQueues } from "../runtime/drafts";
import { STRINGS } from "../runtime/strings";

type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  const result: Element[] = [];
  Children.forEach(tree, (child) => {
    if (isValidElement<Record<string, unknown>>(child))
      result.push(child, ...nodes(child.props.children as ReactNode));
  });
  return result;
}
function view(thread: ThreadState) {
  return nodes(
    ThreadView({
      thread,
      active: true,
      agents: [],
      onGoSettings: vi.fn(),
      onOpened: vi.fn(),
    }),
  );
}
afterEach(() => vi.restoreAllMocks());

it("shows the shared historical notice and its real synchronous acknowledgement without clearing live unknown work", async () => {
  await draftPersistence.load();
  const thread = freshThreadState(
    "history-notice",
    "owned",
    "/owned",
    "native",
  );
  thread.identity = "established";
  thread.historicalOutcomeUnknown = true;
  thread.connectionOutcomeUnknown = true;
  thread.stopUnconfirmed = true;
  vi.spyOn(threads, "thread").mockReturnValue(thread);
  const tree = view(thread);
  expect(
    tree.some(
      (node) => node.props.children === STRINGS.thread.historicalOutcomeUnknown,
    ),
  ).toBe(true);
  const action = tree.find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.acknowledgeHistoricalOutcome,
  )!;
  expect(action.props.disabled).not.toBe(true);
  expect((action.props.onClick as () => unknown)()).toBeUndefined();
  expect(thread.historicalOutcomeUnknown).toBe(false);
  expect(thread.connectionOutcomeUnknown).toBe(true);
  expect(thread.stopUnconfirmed).toBe(true);
  expect(threads.needsAttention(thread)).toBe(true);
  expect(draftQueues.read(thread.key)?.outcomeUnknown).toBe(true);
  expect(
    view(thread).some(
      (node) =>
        node.props.children === STRINGS.thread.acknowledgeHistoricalOutcome,
    ),
  ).toBe(false);
  await draftPersistence.flush();
});

it("does not present an acknowledgement action for a solely live unknown outcome", () => {
  const thread = freshThreadState(
    "live-only-notice",
    "owned",
    "/owned",
    "native",
  );
  thread.connectionOutcomeUnknown = true;
  expect(
    view(thread).some(
      (node) =>
        node.props.children === STRINGS.thread.acknowledgeHistoricalOutcome,
    ),
  ).toBe(false);
});

it("keeps an old rendered acknowledgement from dismissing the replacement view", () => {
  const prior = freshThreadState(
    "replaced-notice",
    "owned",
    "/owned",
    "native",
  );
  prior.historicalOutcomeUnknown = true;
  const tree = view(prior);
  const replacement = { ...prior };
  vi.spyOn(threads, "thread").mockReturnValue(replacement);
  const action = tree.find(
    (node) =>
      node.type === "button" &&
      node.props.children === STRINGS.thread.acknowledgeHistoricalOutcome,
  )!;
  (action.props.onClick as () => void)();
  expect(prior.historicalOutcomeUnknown).toBe(true);
  expect(replacement.historicalOutcomeUnknown).toBe(true);
});
