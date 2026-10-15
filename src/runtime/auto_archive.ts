import { useSyncExternalStore } from "react";
import { archiveActivity } from "./archive_activity";
import { composerDrafts, draftPersistence, hasUnsentWork } from "./drafts";
import {
  hasActiveWork,
  hasPendingRequests,
  type IndexRow,
  type ThreadState,
  threads,
} from "./sessions";

export const ARCHIVE_STRINGS = {
  rules: "哪些对话会被自动归档？",
  description: "将超过所选期限、已确认结束的对话移到已归档。归档结果会保存。",
  known: "只处理 Farfold 已记录活动时间和结束状态的对话；未知旧历史会保留。",
  protected: "收藏、进行中、等待回应及有未发送内容的对话不会自动归档。",
  restored: "手动移回的对话重新等待完整期限。浏览、改名和分组不重新计时。",
  checking: "正在检查归档条件…",
  failed: "自动归档未完成，对话保留原处。可以重试。",
  retry: "重新检查",
  run: "归档符合条件的对话",
  view: "查看已归档",
  off: "自动归档已关闭，已归档的对话保持原位。",
  candidates: (count: number) => `当前有 ${count} 段对话符合条件`,
};
type State = {
  ready: boolean;
  running: boolean;
  count: number;
  error: string | null;
};
let state: State = { ready: false, running: false, count: 0, error: null };
let running: Promise<void> | null = null;
const listeners = new Set<() => void>();
function publish(change: Partial<State>) {
  state = { ...state, ...change };
  listeners.forEach((listener) => listener());
}
export function archiveEligible(
  row: IndexRow,
  live: ThreadState | undefined,
  days: number,
  now = Date.now(),
) {
  const activity = archiveActivity.get(row.id);
  return (
    days > 0 &&
    !!activity?.ended &&
    activity.lastActivityAt <= now - days * 86_400_000 &&
    !row.archived &&
    !row.pinned &&
    !hasUnsentWork(row.id) &&
    (!live ||
      !(
        live.running ||
        live.submitting ||
        live.reconnecting ||
        live.configuring ||
        live.stopping ||
        live.stopUnconfirmed ||
        live.uncertainPrompt ||
        live.connectionOutcomeUnknown ||
        live.connectionLost ||
        live.queued.length ||
        hasActiveWork(live) ||
        hasPendingRequests(live) ||
        threads.needsAttention(live)
      ))
  );
}

export function runAutoArchive(): Promise<void> {
  if (running) return running;
  running = (async () => {
    publish({ running: true, error: null });
    try {
      await draftPersistence.load();
      await archiveActivity.load();
      await archiveActivity.flush();
      if (archiveActivity.hasFailed()) throw new Error(ARCHIVE_STRINGS.failed);
      const snapshot = threads.getSnapshot();
      const candidates = snapshot.index.filter((row) =>
        archiveEligible(row, threads.thread(row.id), snapshot.autoArchiveDays),
      );
      publish({ ready: true, count: candidates.length });
      for (const row of candidates) {
        // Re-read after each asynchronous metadata write. New work always wins.
        const current = threads.getSnapshot();
        const actual = current.index.find((item) => item.id === row.id);
        if (
          actual &&
          archiveEligible(
            actual,
            threads.thread(row.id),
            current.autoArchiveDays,
          )
        )
          await threads.setArchived(row.id, true);
      }
      publish({ ready: true, count: 0 });
    } catch {
      publish({ error: ARCHIVE_STRINGS.failed });
    } finally {
      publish({ running: false });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
export async function retryAutoArchive() {
  try {
    await archiveActivity.retryFailed();
    await runAutoArchive();
  } catch {
    publish({ error: ARCHIVE_STRINGS.failed });
  }
}

export function startAutoArchive() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const schedule = () => {
    if (!active || running) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void runAutoArchive();
    }, 300);
  };
  const offThreads = threads.subscribe(schedule);
  const offDrafts = composerDrafts.subscribe(schedule);
  const offActivity = archiveActivity.subscribe(schedule);
  const clock = setInterval(schedule, 60_000);
  void draftPersistence
    .load()
    .then(() => {
      if (active) schedule();
    })
    .catch(() => publish({ error: ARCHIVE_STRINGS.failed }));
  return () => {
    active = false;
    clearTimeout(timer);
    clearInterval(clock);
    offThreads();
    offDrafts();
    offActivity();
  };
}
export function useAutoArchive() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
}
