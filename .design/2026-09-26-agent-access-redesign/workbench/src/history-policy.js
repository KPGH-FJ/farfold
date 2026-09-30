// Prototype metadata policy. It never reads or reconstructs Agent history.
import { conversationState } from "./conversation-policy.js";
const DAY = 24 * 60 * 60 * 1000;
const hasText = (value) => typeof value === "string" && Boolean(value.trim());
const hasItems = (value) => Array.isArray(value) && value.length > 0;
export function hasUnsentContent(task) {
  return Boolean(
    hasText(task.draft) ||
    hasText(task.answerDraft) ||
    (!task.answerSubmitted && hasText(task.answerDraft?.note)) ||
    hasItems(task.draftAttachments) ||
    hasItems(task.attachments) ||
    [
      ...Object.values(task.feedbackDrafts || {}),
      ...Object.values(task.contentDrafts || {}),
    ].some((entry) => hasText(typeof entry === "string" ? entry : entry?.text)),
  );
}

export function archiveEligibility(task) {
  if (!task) return { allowed: false, reason: "未找到这段对话。" };
  const state = conversationState(task);
  return { allowed: state.canArchive, reason: state.archiveReason || "" };
}

// An old or conflicting archive flag must not hide active work.
export function visibleInActive(task) {
  return !task.archived || !archiveEligibility(task).allowed;
}

export const needsAttention = (task) => conversationState(task).attention;
export const isWorking = (task) => conversationState(task).running;

export function filterConversations(tasks, filters = {}) {
  const query = (filters.query || "").trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    const visible = visibleInActive(task);
    return (
      (filters.state === "archived" ? !visible : visible) &&
      (!filters.starred || task.pinned) &&
      (!filters.agent || task.agent === filters.agent) &&
      (!filters.group || task.group === filters.group) &&
      (!query ||
        [task.title, task.agent, task.group, task.folder]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)) &&
      (filters.state === "needs"
        ? needsAttention(task)
        : filters.state === "running"
          ? isWorking(task)
          : filters.state === "unread"
            ? task.unread
            : true)
    );
  });
}

export function restoreConversation(task, now = Date.now()) {
  return {
    ...task,
    archived: false,
    archivedAt: null,
    archiveSource: null,
    archiveRestoredAt: now,
  };
}

export function autoArchiveEligibility(task, days, now = Date.now()) {
  const manual = archiveEligibility(task);
  if (task.archived) return { allowed: false, reason: "已归档" };
  if (!Number.isFinite(Number(days)) || Number(days) <= 0)
    return { allowed: false, reason: "自动归档已关闭" };
  if (!manual.allowed) return manual;
  if (task.pinned) return { allowed: false, reason: "收藏的对话会保留" };
  if (hasUnsentContent(task))
    return { allowed: false, reason: "还有未发送的内容" };
  if (
    !["done", "stopped", "failed"].includes(task.status) ||
    task.completionKnown === false
  )
    return { allowed: false, reason: "尚未确认已经结束" };
  if (
    !Number.isFinite(task.lastActivityAt) ||
    task.lastActivityAt <= 0 ||
    task.lastActivityKnown === false
  )
    return { allowed: false, reason: "最后活动时间未知" };
  const since = Math.max(task.lastActivityAt, task.archiveRestoredAt || 0);
  return now - since >= Number(days) * DAY
    ? { allowed: true, reason: "已达到无活动期限" }
    : { allowed: false, reason: "尚未达到无活动期限" };
}

export function applyArchivePolicy(tasks, days, now = Date.now()) {
  const archivedIds = [];
  const next = tasks.map((task) => {
    if (!autoArchiveEligibility(task, days, now).allowed) return task;
    archivedIds.push(task.id);
    return {
      ...task,
      archived: true,
      archivedAt: now,
      archiveSource: "automatic",
    };
  });
  return { tasks: next, archivedIds, count: archivedIds.length };
}

// All UI archive actions must enter here, including menus and bulk actions.
export function patchConversationMetadata(task, patch, now = Date.now()) {
  const merged = { ...task, ...patch };
  if (patch.archived === true) {
    const eligibility = archiveEligibility(merged);
    if (!eligibility.allowed) return { task, error: eligibility.reason };
    return {
      task: { ...merged, archivedAt: now, archiveSource: "manual" },
      error: null,
    };
  }
  if (patch.archived === false && task.archived)
    return { task: restoreConversation(merged, now), error: null };
  const activityChanged = [
    "draft",
    "draftAttachments",
    "attachments",
    "answerDraft",
    "queue",
    "extraMessages",
    "contentDrafts",
    "feedbackDrafts",
  ].some(
    (key) =>
      Object.prototype.hasOwnProperty.call(patch, key) &&
      JSON.stringify(patch[key]) !== JSON.stringify(task[key]),
  );
  // Reading old history is not new work. A load returning status=done must
  // neither invent a historical timestamp nor restart an old archive clock.
  const liveActivity =
    patch.status &&
    patch.status !== task.status &&
    task.status !== "recovery" &&
    !task.recoveryRead &&
    !patch.recoveryRead &&
    !["recovery"].includes(patch.status);
  return {
    task:
      activityChanged || liveActivity
        ? { ...merged, lastActivityAt: now, lastActivityKnown: true }
        : merged,
    error: null,
  };
}
