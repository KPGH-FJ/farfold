import { afterEach, expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
  workEnabled: true,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => h.workEnabled }),
}));

import { Composer } from "./Composer";
import { ThreadView } from "./ThreadView";
import {
  freshThreadState,
  applyTurnEnd,
  applyUpdate,
} from "../runtime/session_projection";
import { threads, type ThreadState } from "../runtime/sessions";
import { composerDrafts, draftPersistence } from "../runtime/drafts";
import { COMPOSER_CONTROLS as C } from "../runtime/composer_strings";
import { STRINGS } from "../runtime/strings";

function render(thread: ThreadState) {
  let tree: ReactNode;
  function Capture() {
    tree = Composer({ thread, imageEnabled: false, onGoSettings: () => {} });
    return tree;
  }
  const html = renderToStaticMarkup(<Capture />);
  const elements: ReactElement<Record<string, unknown>>[] = [];
  const visit = (node: ReactNode) =>
    Children.forEach(node, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return;
      elements.push(child);
      visit(child.props.children as ReactNode);
    });
  visit(tree);
  return {
    html,
    button: (name: string) =>
      elements.find(
        (element) =>
          element.type === "button" && element.props["aria-label"] === name,
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  h.invoke.mockReset().mockResolvedValue(null);
  h.workEnabled = true;
});

it.each(["stopped", "work_disabled", "no_result"] as const)(
  "labels explicit new input as send after an empty %s pause can be released",
  async (pause) => {
    vi.spyOn(draftPersistence, "load").mockResolvedValue();
    vi.spyOn(draftPersistence, "flush").mockResolvedValue();
    h.invoke.mockImplementation(async (command) =>
      command === "session_prompt" ? { status: "accepted" } : null,
    );
    const key = `restored-empty-${pause}`;
    const thread = threads.markOpenFailed(
      key,
      "a",
      "/restored",
      key,
      "fixture",
    );
    thread.openError = null;
    thread.identity = "established";
    thread.resumed = true;
    applyUpdate(thread, {
      sessionUpdate: "tool_call",
      toolCallId: "historical-stopped-tool",
      title: "Earlier command",
      status: "failed",
    });
    thread.permissionConfigId = "permission";
    thread.permissionState = "ready";
    thread.queuePaused = pause;
    if (pause === "work_disabled") {
      threads.updateWork(thread.cwd, {}, false);
      threads.updateWork(thread.cwd, {}, true);
    }
    composerDrafts.update(`session:${key}`, () => ({
      text: "Explicit new input",
      attachments: [],
    }));
    const view = render(thread);
    expect(thread.activeToolCallIds).toEqual([]);
    expect(thread.queuePaused).toBe(pause);
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
    const action =
      view.button(STRINGS.composer.sendTitle) ?? view.button(C.addQueued);
    expect(action?.props.disabled).toBe(false);
    (action!.props.onClick as () => void)();
    await vi.waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "session_prompt",
        expect.objectContaining({
          content: [{ type: "text", text: "Explicit new input" }],
        }),
      ),
    );
    expect(thread.queuePaused).toBeNull();
    expect(thread.queued).toEqual([]);
    composerDrafts.clear(`session:${key}`);
    expect(view.button(STRINGS.composer.sendTitle)).toBeDefined();
    expect(view.button(C.addQueued)).toBeUndefined();
  },
);

it.each(["queued", "running", "permission"] as const)(
  "preserves the pause and queue label while %s still blocks new input",
  async (blocker) => {
    const key = `restored-blocked-${blocker}`;
    const thread = threads.markOpenFailed(key, "a", "/blocked", key, "fixture");
    thread.openError = null;
    thread.queuePaused = "stopped";
    thread.permissionConfigId = "permission";
    thread.permissionState = blocker === "permission" ? "required" : "ready";
    thread.running = blocker === "running";
    const prior = [{ type: "text" as const, text: "Existing paused input" }];
    if (blocker === "queued") thread.queued = [prior];
    composerDrafts.update(`session:${key}`, () => ({
      text: "Explicit new input",
      attachments: [],
    }));
    const view = render(thread);
    expect(view.button(C.addQueued)).toBeDefined();
    expect(view.button(STRINGS.composer.sendTitle)).toBeUndefined();
    expect(view.button(C.addQueued)?.props.disabled).toBe(
      blocker === "permission",
    );
    const blocks = [{ type: "text" as const, text: "Explicit new input" }];
    expect(await threads.send(key, blocks)).toEqual({ status: "queued" });
    expect(thread.queuePaused).toBe("stopped");
    expect(thread.queued).toEqual(
      blocker === "queued" ? [prior, blocks] : [blocks],
    );
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
    composerDrafts.clear(`session:${key}`);
  },
);

it("offers mouse queue submission alongside stop without starting another request", async () => {
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  const thread = threads.markOpenFailed(
    "mouse-queue",
    "a",
    "/p",
    "mouse-queue",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  thread.identity = "established";
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "Next step",
    attachments: [],
  }));
  const view = render(thread);
  expect(view.button(STRINGS.composer.stopTitle)?.props.disabled).toBe(false);
  const enqueue = view.button("加入待发");
  expect(enqueue).toBeDefined();
  expect(enqueue!.props.disabled).toBe(false);
  (enqueue!.props.onClick as () => void)();
  await vi.waitFor(() =>
    expect(thread.queued).toEqual([[{ type: "text", text: "Next step" }]]),
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
  expect(thread.running).toBe(true);
  thread.stopping = true;
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "Keep stopped draft",
    attachments: [],
  }));
  expect(render(thread).button("加入待发")?.props.disabled).toBe(true);
  composerDrafts.clear(`session:${thread.key}`);
});

it("keeps the waiting confirmation beside the input with a disabled stop control", () => {
  const thread = freshThreadState("a:/p:waiting", "a", "/p", "waiting");
  thread.running = true;
  thread.stopping = true;
  const { html, button } = render(thread);
  expect(html).toContain(C.stopWaiting);
  expect(html).toContain(C.stopWaitingNote);
  expect(html).toContain(`aria-label="${C.stopStatus}"`);
  expect(button(STRINGS.repair.stopping)?.props.disabled).toBe(true);
  expect(html).not.toContain(STRINGS.composer.hintQueue);
  expect(html).not.toContain(STRINGS.thread.stopped);
});

it("moves unknown stop recovery out of the scrollable transcript and into the composer only once", () => {
  const thread = freshThreadState("a:/p:unknown", "a", "/p", "unknown");
  thread.stopUnconfirmed = true;
  thread.connectionOutcomeUnknown = true;
  const html = renderToStaticMarkup(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
  const composerIndex = html.indexOf('class="composer-wrap"');
  expect(composerIndex).toBeGreaterThan(-1);
  expect(html.indexOf(`aria-label="${C.stopStatus}"`)).toBeGreaterThan(
    composerIndex,
  );
  expect(html.match(/class="c-stop c-stop-retry"/g)).toHaveLength(1);
  expect(render(thread).button(STRINGS.repair.retryStop)?.props.disabled).toBe(
    false,
  );
  thread.connectionLost = true;
  expect(render(thread).button(STRINGS.repair.retryStop)?.props.disabled).toBe(
    true,
  );
});

it("keeps stop available while work or permission settings pause sending and preserves the queue on confirmation", async () => {
  vi.useFakeTimers();
  h.workEnabled = false;
  const thread = threads.markOpenFailed(
    "a:/p:stop-paused",
    "a",
    "/p",
    "stop-paused",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  thread.permissionConfigId = "permission";
  thread.permissionState = "unknown";
  thread.queued = [[{ type: "text", text: "later" }]];
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "draft remains",
    attachments: [],
  }));
  const stop = render(thread).button(STRINGS.composer.stopTitle)!;
  expect(stop.props.disabled).toBe(false);
  (stop.props.onClick as () => void)();
  expect(h.invoke).toHaveBeenCalledWith(
    "session_cancel",
    expect.objectContaining({ sessionId: thread.nativeSessionId }),
  );
  expect(thread.stopping).toBe(true);
  expect(thread.queuePaused).toBe("stopped");
  applyTurnEnd(thread, { stopReason: "cancelled" });
  expect(render(thread).html).not.toContain(C.stopStatus);
  expect(thread.queued).toEqual([[{ type: "text", text: "later" }]]);
  expect(composerDrafts.read(`session:${thread.key}`).text).toBe(
    "draft remains",
  );
  expect(
    h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("shows a failed cancel as unknown and offers an explicit retry without claiming nondelivery", async () => {
  vi.useFakeTimers();
  const thread = threads.markOpenFailed(
    "a:/p:stop-failed",
    "a",
    "/p",
    "stop-failed",
    "fixture",
  );
  thread.openError = null;
  thread.running = true;
  h.invoke.mockRejectedValueOnce(new Error("transport failure"));
  await threads.cancel(thread.key);
  const { html, button } = render(thread);
  expect(html).toContain(C.stopUnknown);
  expect(button(STRINGS.repair.retryStop)?.props.disabled).toBe(false);
  expect(html).not.toContain("停止请求未发送");
  expect(html).not.toContain(STRINGS.thread.stopped);
  expect(thread.queued).toEqual([]);
});
