import { completion } from "./completion";
import {
  hasPendingRequests,
  type ThreadItem,
  type ThreadState,
} from "./session_types";
import type { TaskState } from "./async_tasks";

type Ending = Extract<ThreadItem, { kind: "settled" }>;
interface Candidate {
  connection: string | undefined;
  session: string;
  base: number;
  current: () => boolean;
  priorTerminalTasks: Set<string>;
  priorActiveTools: Set<string>;
  tasks: Map<string, TaskState>;
  end?: Ending;
  decided: boolean;
  failed: boolean;
}

/** One current live request per actual thread object. No stored history or
 * inferred task IDs: only the Agent's received task/tool identities are used. */
export class SuccessNotifications {
  private candidates = new WeakMap<ThreadState, Candidate>();

  constructor(
    private readonly notify: (
      thread: ThreadState,
      endingId: string,
      current: () => boolean,
    ) => void,
  ) {}

  /** Called by the real send path, not by restored text or a terminal replay. */
  begin = (s: ThreadState, current: () => boolean): void => {
    this.candidates.set(s, {
      connection: s.connectionId,
      session: s.nativeSessionId,
      base: s.roundItemBase,
      current,
      priorTerminalTasks: new Set(
        (s.asyncTasks?.tasks ?? [])
          .filter((task) => !["running", "unknown"].includes(task.state))
          .map((task) => task.asyncTaskId),
      ),
      priorActiveTools: new Set(s.activeToolCallIds),
      tasks: new Map(),
      decided: false,
      failed: false,
    });
    this.check(s);
  };

  /** Observe before projection, then inspect the actual projected ending. */
  observe = (s: ThreadState, event: unknown, live: boolean): void => {
    if (!live || !event || typeof event !== "object") return;
    const candidate = this.candidates.get(s);
    if (!candidate || !this.owns(s, candidate)) return;
    const e = event as Record<string, unknown>;
    this.capture(s, candidate);
    if (
      e.kind === "connectionLost" ||
      e.kind === "serviceUnavailable" ||
      (e.kind === "toolActivity" &&
        e.reason === "process_ended" &&
        s.activeToolCallIds.length)
    ) {
      this.candidates.delete(s);
      return;
    }
    const length = s.items.length;
    const ending = e.kind === "turnEnd";
    if (
      ending &&
      !s.running &&
      !s.uncertainPrompt &&
      !s.connectionOutcomeUnknown
    )
      return;
    if (
      ending &&
      completion({
        stopReason: typeof e.stopReason === "string" ? e.stopReason : undefined,
        error: typeof e.error === "string" ? e.error : undefined,
        failure: e.failure,
      }).status !== "done"
    ) {
      this.candidates.delete(s);
      return;
    }
    // Projection remains synchronous; no timer is evidence of work completion.
    queueMicrotask(() => {
      if (!this.owns(s, candidate)) return;
      if (ending) {
        const projected = s.items
          .slice(length)
          .find((item) => item.kind === "settled");
        if (
          !projected ||
          projected.kind !== "settled" ||
          projected.status !== "done"
        ) {
          this.candidates.delete(s);
          return;
        }
        candidate.end ??= projected;
      }
      this.check(s);
    });
  };

  private owns(s: ThreadState, c: Candidate): boolean {
    return (
      this.candidates.get(s) === c &&
      c.current() &&
      Boolean(c.connection) &&
      s.connectionId === c.connection &&
      s.nativeSessionId === c.session &&
      s.roundItemBase === c.base &&
      !s.connectionLost &&
      !s.reconnecting &&
      !s.openError &&
      !s.sourceError
    );
  }

  private successful(s: ThreadState, c: Candidate): boolean {
    this.capture(s, c);
    const end = c.end;
    if (
      c.failed ||
      !this.owns(s, c) ||
      !end ||
      !s.items.includes(end) ||
      end.status !== "done" ||
      end.stopReason !== "end_turn" ||
      end.error ||
      end.replyReceived === undefined ||
      s.running ||
      s.submitting ||
      s.stopping ||
      s.stopUnconfirmed ||
      s.uncertainPrompt ||
      s.connectionOutcomeUnknown ||
      s.activeToolCallIds.length ||
      hasPendingRequests(s) ||
      (s.permissionConfigId && s.permissionState !== "ready")
    )
      return false;
    // A received reply cannot hide a failed or still-running tool/compaction.
    const currentTools = s.items
      .slice(c.base)
      .filter((item) => item.kind === "tool");
    const carriedTools = s.items.filter(
      (item) =>
        item.kind === "tool" && c.priorActiveTools.has(item.call.toolCallId),
    );
    if (
      [...c.priorActiveTools].some(
        (id) =>
          !carriedTools.some(
            (item) => item.kind === "tool" && item.call.toolCallId === id,
          ),
      )
    )
      return false;
    const tools = [...new Set([...currentTools, ...carriedTools])];
    if (
      (end.artifactToolItemIds ?? []).some(
        (id) => !tools.some((item) => item.id === id),
      ) ||
      tools.some(
        (item) => item.kind === "tool" && item.call.status !== "completed",
      )
    )
      return false;
    const compactions = s.items
      .slice(c.base)
      .filter((item) => item.kind === "compaction");
    if (
      (end.compactionItemIds ?? []).some(
        (id) => !compactions.some((item) => item.id === id),
      ) ||
      compactions.some(
        (item) =>
          item.kind === "compaction" &&
          (item.status !== "completed" || item.observation || item.error),
      )
    )
      return false;
    const owned = s.asyncTasks;
    if (
      owned &&
      (owned.connectionId !== c.connection ||
        owned.sessionId !== c.session ||
        owned.overflow)
    )
      return false;
    if ([...c.tasks.values()].some((state) => state !== "completed"))
      return false;
    return (
      end.replyReceived ||
      currentTools.some(
        (item) => item.kind === "tool" && item.call.kind !== "think",
      )
    );
  }

  private capture(s: ThreadState, c: Candidate): void {
    if (
      s.items
        .slice(c.base)
        .some(
          (item) =>
            (item.kind === "tool" && item.call.status === "failed") ||
            (item.kind === "compaction" &&
              ["failed", "cancelled"].includes(item.status)),
        )
    )
      c.failed = true;
    const toolIds = new Set(
      s.items
        .slice(c.base)
        .flatMap((item) =>
          item.kind === "tool" ? [item.call.toolCallId] : [],
        ),
    );
    const owned = s.asyncTasks;
    if (
      owned &&
      owned.connectionId === c.connection &&
      owned.sessionId === c.session
    ) {
      for (const task of owned.tasks) {
        if (
          !c.priorTerminalTasks.has(task.asyncTaskId) ||
          (task.toolCallId !== null && toolIds.has(task.toolCallId))
        ) {
          if (!c.tasks.has(task.asyncTaskId) && c.tasks.size >= 512) {
            c.failed = true;
            continue;
          }
          c.tasks.set(task.asyncTaskId, task.state);
          if (["failed", "stopped"].includes(task.state)) c.failed = true;
        }
      }
    }
  }

  /** Also called after real send admission settles; that await is not an end. */
  check = (s: ThreadState): void => {
    const c = this.candidates.get(s);
    if (!c || c.decided) return;
    if (!this.owns(s, c)) {
      this.candidates.delete(s);
      return;
    }
    if (!this.successful(s, c)) return;
    c.decided = true;
    this.notify(s, c.end!.id, () => this.successful(s, c));
  };
}
