const DAY = 24 * 60 * 60 * 1000;

export function archiveReviewTasks(now = Date.now()) {
  const sample = (id, title, extra = {}) => ({
    id: `archive-review-${id}`,
    title,
    agent: "Codex",
    model: "6 Astra",
    effort: "High",
    source: "沿用已有设置",
    project: "普通对话",
    group: "",
    status: "done",
    draft: "",
    queue: [],
    lastActivityAt: now - 45 * DAY,
    time: "45 天前",
    ...extra,
  });
  return [
    sample("eligible", "已结束的旧对话 · 可以自动归档"),
    sample("favorite", "收藏的旧对话 · 保留", { pinned: true }),
    sample("queue", "还有待发消息 · 保留", {
      queue: [{ id: "q-archive", text: "稍后继续这个思路" }],
      queuePaused: true,
    }),
    sample("unknown", "结果未知 · 保留", { status: "unknown" }),
    sample("untimed", "历史活动时间未知 · 保留", {
      lastActivityAt: null,
      time: "时间未知",
    }),
    sample("draft", "还有未发送草稿 · 保留", { draft: "还想补充这一点" }),
    sample("restored", "刚恢复的旧对话 · 重新计时", { archiveRestoredAt: now }),
  ];
}
