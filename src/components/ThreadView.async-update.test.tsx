import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { freshThreadState, applyUpdate } from "../runtime/session_projection";
import { receiveAsyncTasks } from "../runtime/async_tasks";
import { ThreadView } from "./ThreadView";
import { STRINGS } from "../runtime/strings";
import { ASYNC_TASKS } from "../runtime/async_task_strings";
const spawned = {
  sessionUpdate: "async_task_spawned",
  asyncTaskId: "reported-task",
  name: "Controlled task",
  taskType: "shell",
  showInTranscript: false,
  canStop: true,
  toolCallId: "reported-tool",
  extension: { future: [0, false, null] },
};
const stopped = {
  sessionUpdate: "async_task_state_update",
  asyncTaskId: "reported-task",
  state: "stopped",
  toolCallId: "reported-tool",
};
function setup(supported = true) {
  const s = freshThreadState("view", "fixture", "/controlled", "session");
  s.connectionId = "connection";
  receiveAsyncTasks(s, {
    kind: "asyncTasks",
    connectionId: "connection",
    sessionId: "session",
    supported,
    overflow: false,
    tasks: [],
  });
  return s;
}
const render = (s: ReturnType<typeof setup>) =>
  renderToStaticMarkup(
    <ThreadView
      thread={s}
      active
      agents={[]}
      onGoSettings={() => {}}
      onOpened={() => {}}
    />,
  );
const apply = (
  s: ReturnType<typeof setup>,
  update: unknown,
  sessionId = "session",
) =>
  applyUpdate(s, update, {
    sessionId,
    update,
    futureEnvelope: { opaque: "retained-envelope" },
  });
it.each([spawned, stopped])(
  "labels a complete negotiated task event without changing raw data or task/turn/queue state: $sessionUpdate",
  (update) => {
    const s = setup();
    s.queuePaused = "stopped";
    s.queued = [[{ type: "text", text: "unsent" }]];
    const before = structuredClone({
      tasks: s.asyncTasks,
      queued: s.queued,
      queuePaused: s.queuePaused,
    });
    apply(s, update);
    const item = s.items[0];
    expect(item).toMatchObject({ kind: "raw", label: "asyncTaskUpdate" });
    expect(item.kind === "raw" && item.update).toBe(update);
    expect(item.reportedDetails?.["/futureEnvelope"]).toEqual({
      opaque: "retained-envelope",
    });
    expect({
      tasks: s.asyncTasks,
      queued: s.queued,
      queuePaused: s.queuePaused,
    }).toEqual(before);
    const html = render(s);
    expect(html).toContain("后台任务更新");
    expect(html).not.toContain(STRINGS.thread.rawUpdate);
    expect(html).toContain(update.sessionUpdate);
    expect(html).toContain("retained-envelope");
    expect(html).not.toContain(ASYNC_TASKS.stopped);
  },
);
it("keeps malformed, future-state and unrecognized kinds fully visible as unknown", () => {
  for (const update of [
    { ...spawned, asyncTaskId: 1 },
    { ...spawned, name: null },
    { ...spawned, taskType: {} },
    { ...spawned, canStop: "true" },
    { ...spawned, toolCallId: 2 },
    { ...spawned, showInTranscript: 1 },
    { ...spawned, name: "中".repeat(1400) },
    { ...stopped, state: "future-terminal" },
    { ...stopped, state: null },
    { ...stopped, toolCallId: [] },
    { ...stopped, sessionUpdate: "future_async_task" },
  ]) {
    const s = setup();
    apply(s, update);
    expect(s.items[0]).toMatchObject({ kind: "raw", update });
    expect(s.items[0].kind === "raw" && s.items[0].label).toBeUndefined();
    expect(render(s)).toContain(STRINGS.thread.rawUpdate);
  }
});
it("does not label undeclared capabilities or another session/connection using a previously accepted declaration", () => {
  const cases = [setup(false), setup(), setup(), setup()];
  cases[1].connectionId = "new-connection";
  cases[2].nativeSessionId = "new-session";
  cases[3].connectionLost = true;
  for (const s of cases) {
    apply(s, spawned);
    expect(render(s)).toContain(STRINGS.thread.rawUpdate);
  }
  const s = setup();
  apply(s, spawned, "other-session");
  expect(render(s)).toContain(STRINGS.thread.rawUpdate);
  const noEnvelope = setup();
  applyUpdate(noEnvelope, spawned);
  expect(render(noEnvelope)).toContain(STRINGS.thread.rawUpdate);
});
it("rejects a cross-session declaration and keeps an earlier recognized label historical after context changes", () => {
  const s = setup();
  apply(s, spawned);
  const first = s.items[0];
  s.nativeSessionId = "new-session";
  expect(
    receiveAsyncTasks(s, {
      kind: "asyncTasks",
      connectionId: "connection",
      sessionId: "session",
      supported: true,
      overflow: false,
      tasks: [],
    }),
  ).toBe(false);
  apply(s, stopped, "new-session");
  expect(first).toMatchObject({ label: "asyncTaskUpdate" });
  expect(
    s.items.at(-1)?.kind === "raw" &&
      (s.items.at(-1) as { label?: string }).label,
  ).toBeUndefined();
  expect(render(s)).toContain(STRINGS.thread.rawUpdate);
});
