import React, { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AsyncTasks } from "/src/components/AsyncTasks";
import { threads } from "/src/runtime/sessions";
import { hasActiveTools } from "/src/runtime/session_types";
import "/src/styles.css";
import "/src/product-shell.css";
const state = threads.markOpenFailed(
  "fixture:/controlled:native",
  "fixture",
  "/controlled",
  "native",
  "fixture",
);
state.openError = null;
state.connectionId = "connection";
state.queuePaused = "stopped";
state.queued = [[{ type: "text", text: "Retained queued draft" }]];
const event = (value) => threads.applyChannelEvent(state.key, value);
const value = {
  kind: "asyncTasks",
  connectionId: "connection",
  sessionId: "native",
  supported: true,
  overflow: false,
  tasks: [
    {
      asyncTaskId: "exact-1",
      name: "受控后台任务 · 保留完整执行归属",
      taskType: "shell",
      toolCallId: "original-tool",
      canStop: true,
      state: "running",
      stopRequest: "idle",
    },
  ],
};
let resolve;
window.testInvoke = async (cmd, args) => {
  window.calls.push({ cmd, args });
  if (cmd === "session_stop_task")
    return new Promise((r) => {
      resolve = r;
    });
  if (cmd === "settings_get") return null;
  return [];
};
event(value);
window.fixture = {
  event: () => structuredClone(value),
  state,
  accepted: () =>
    resolve?.({
      connectionId: "connection",
      sessionId: "native",
      asyncTaskId: "exact-1",
      status: "accepted",
    }),
  terminal: () => {
    value.tasks[0].state = "completed";
    event(value);
  },
  reset: () => {
    state.connectionLost = false;
    value.tasks[0].state = "running";
    value.tasks[0].stopRequest = "idle";
    event(value);
  },
  lost: () => event({ kind: "connectionLost" }),
  wrong: () => event({ ...value, connectionId: "old", tasks: [] }),
  snapshot: () => ({
    busy: hasActiveTools(state),
    queue: state.queued,
    pause: state.queuePaused,
    items: state.items,
    task: state.asyncTasks.tasks[0],
  }),
  calls: () => window.calls.filter((c) => c.cmd === "session_stop_task"),
};
function View() {
  useSyncExternalStore(threads.subscribe, threads.getSnapshot);
  const [active, setActive] = useState(true);
  return (
    <main style={{ maxWidth: 760, margin: "32px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>受控后台任务交互</h1>
      <p>真实组件与状态路由；本页返回受控回执，不执行外部任务。</p>
      <button onClick={() => setActive(!active)}>
        {active ? "隐藏控制" : "恢复控制"}
      </button>
      <AsyncTasks thread={state} active={active} />
      <p>待发消息保持暂停。</p>
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <View />
  </StrictMode>,
);
