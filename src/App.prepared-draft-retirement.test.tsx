import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  call,
  cleanupHarness,
  component,
  h,
  render,
  resetHarness,
} from "./App.test-harness";
import { threads as routedThreads } from "./runtime/sessions";

beforeEach(resetHarness);
afterEach(cleanupHarness);

it("waits for a confirmed index after the mounted app's initial read fails", async () => {
  const { threads } =
    await vi.importActual<typeof import("./runtime/sessions")>(
      "./runtime/sessions",
    );
  h.indexSource = threads;
  let rejectRead!: (reason: Error) => void;
  const reading = new Promise<never>((_resolve, reject) => {
    rejectRead = reject;
  });
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "session_index_list") return reading;
    if (command === "app_default_working_directory") return "/ordinary";
    return null;
  });
  vi.mocked(routedThreads.refreshIndex).mockClear();
  for (const effect of h.effects) effect?.cleanup?.();
  h.effects = [];
  h.slots = [];
  h.pending = [];
  render();
  await Promise.resolve();
  const initialReads = vi
    .mocked(routedThreads.refreshIndex)
    .mock.results.map(({ value }) => value);
  expect(initialReads.length).toBeGreaterThan(0);
  const whileReading = component("EmptyState").availableFeedbackOwners;
  rejectRead(new Error("index unreadable"));
  await Promise.all(initialReads);
  const afterFailure = component("EmptyState").availableFeedbackOwners;

  h.invoke.mockImplementation(async (command: string) =>
    command === "session_index_list" ? [] : null,
  );
  const beforeEmpty = threads.getSnapshot().index;
  await routedThreads.refreshIndex();
  expect(threads.getSnapshot().index).toBe(beforeEmpty);
  expect(whileReading).toBeUndefined();
  expect(afterFailure).toBeUndefined();
  expect(component("EmptyState").availableFeedbackOwners).toEqual(new Set());
});

it("passes the actual prepared editor owner without replacing the original new input", () => {
  const originalDraft = structuredClone(h.draft);
  const owner = () => true;
  call("EmptyState", "onPreparedKey", "prepared-A");
  call("EmptyState", "onPreparedComposerOwner", owner);
  expect(component("ThreadPage").preparedComposerIsCurrent).toBe(owner);
  expect(h.draft).toEqual(originalDraft);
  call("EmptyState", "onPreparedComposerOwner", null);
  expect(component("ThreadPage").preparedComposerIsCurrent).toBeNull();
});

it.each(["start", "library"])(
  "releases a retired prepared workspace on %s without changing navigation or draft choice",
  (route) => {
    const originalDraft = structuredClone(h.draft);
    const originalChoice = structuredClone(h.choice);
    h.index = [{ id: "indexed-A", agentId: "A" }];
    call("EmptyState", "onPreparedKey", "prepared-A");
    expect(component("ThreadPage")).toMatchObject({
      viewKey: "prepared-A",
      active: true,
    });
    expect(component("EmptyState").availableFeedbackOwners).toEqual(
      new Set(["indexed-A", "prepared-A"]),
    );
    if (route === "library") call("Sidebar", "onLibrary", { kind: "all" });

    // This is the child's retirement callback, not a navigation request.
    call("EmptyState", "onPreparedKey", null);
    expect(component("EmptyState").availableFeedbackOwners).toEqual(
      new Set(["indexed-A"]),
    );
    expect(
      render().some(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      ),
    ).toBe(false);
    expect(component("EmptyState").active).toBe(route === "start");
    expect(component("ConversationLibrary").active).toBe(route === "library");

    call("Sidebar", "onNew");
    expect(component("EmptyState").active).toBe(true);
    expect(
      render().some(
        (node) =>
          typeof node.type === "function" && node.type.name === "ThreadPage",
      ),
    ).toBe(false);
    expect(h.draft).toEqual(originalDraft);
    expect(h.choice).toEqual(originalChoice);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.clearDraft).not.toHaveBeenCalled();
  },
);
