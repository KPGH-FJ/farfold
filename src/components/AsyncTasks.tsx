import type { ThreadState } from "../runtime/session_types";
import { useEffect, useRef } from "react";
import { canStopAsyncTask } from "../runtime/async_tasks";
import { ASYNC_TASKS as T } from "../runtime/async_task_strings";
import { threads } from "../runtime/sessions";
import {
  asyncTaskToolLocations,
  type AsyncTaskTool,
} from "../runtime/async_task_location";
import "./AsyncTasks.css";

export function AsyncTasks({
  thread,
  active,
  onShowTool,
}: {
  thread: ThreadState;
  active: boolean;
  onShowTool?: (tool: AsyncTaskTool) => void;
}) {
  const owner = thread.asyncTasks;
  const latest = useRef({ thread, owner, active });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  latest.current = { thread, owner, active };
  if (!owner?.supported || (!owner.tasks.length && !owner.overflow))
    return null;
  const locations = onShowTool ? asyncTaskToolLocations(thread) : null;
  return (
    <section className="async-tasks" aria-label={T.title}>
      <details open>
        <summary>
          {T.title} · {owner.tasks.length}
        </summary>
        <p>{T.description}</p>
        {owner.overflow && <p role="status">{T.overflow}</p>}
        <ul>
          {owner.tasks.map((task) => {
            const source = task.toolCallId
              ? locations?.get(task.toolCallId)
              : undefined;
            const unsettled =
              task.state === "running" || task.state === "unknown";
            const status =
              thread.connectionLost && unsettled
                ? T.disconnected
                : !unsettled
                  ? T[task.state as "completed" | "failed" | "stopped"]
                  : task.stopRequest !== "idle"
                    ? T[task.stopRequest]
                    : T[task.state as "running" | "unknown"];
            return (
              <li key={task.asyncTaskId}>
                <span className="async-task-name">{task.name}</span>
                <span className="async-task-status" role="status">
                  {status}
                </span>
                {source && onShowTool ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!active}
                    onClick={() => {
                      if (
                        mounted.current &&
                        latest.current.active &&
                        latest.current.thread === thread &&
                        latest.current.owner === owner &&
                        thread.asyncTasks === owner &&
                        threads.thread(thread.key) === thread &&
                        asyncTaskToolLocations(thread).get(task.toolCallId!) ===
                          source
                      )
                        onShowTool(source);
                    }}
                  >
                    {T.source}
                  </button>
                ) : task.toolCallId && onShowTool ? (
                  <span className="async-task-status">
                    {T.sourceUnavailable}
                  </span>
                ) : null}
                {unsettled && task.canStop && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!active || !canStopAsyncTask(thread, task)}
                    onClick={() => {
                      if (
                        mounted.current &&
                        latest.current.active &&
                        latest.current.thread === thread &&
                        latest.current.owner === owner &&
                        thread.asyncTasks === owner &&
                        threads.thread(thread.key) === thread
                      )
                        void threads.stopTask(thread.key, task);
                    }}
                  >
                    {T.stop}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
