// Preview metadata only. Checking these choices does not read real files.
const label = (file) =>
  typeof file === "string" ? file : file?.path || file?.name || "未命名附件";
export function threadAttachmentReviewItems(task) {
  const items = [];
  for (const field of ["attachments", "draftAttachments"]) {
    (task[field] || []).forEach((file, index) =>
      items.push({
        id: `${field}:${index}`,
        label: `当前输入 · ${label(file)}`,
        file,
      }),
    );
  }
  (task.queue || []).forEach((message, position) => {
    if (typeof message === "string") return;
    (message.attachments || []).forEach((file, index) =>
      items.push({
        id: `queue:${position}:${index}`,
        label: `第 ${position + 1} 条待发 · ${label(file)}`,
        file,
      }),
    );
  });
  return items;
}

export function confirmThreadAttachments(task, keptIds) {
  const kept = new Set(keptIds);
  const current = threadAttachmentReviewItems(task)
    .filter((item) => !item.id.startsWith("queue:") && kept.has(item.id))
    .map((item) => item.file);
  return {
    attachments: current.filter(
      (file, index) =>
        current.findIndex(
          (other) => JSON.stringify(other) === JSON.stringify(file),
        ) === index,
    ),
    draftAttachments: [],
    queue: (task.queue || []).map((message, position) =>
      typeof message === "string"
        ? message
        : {
            ...message,
            attachments: (message.attachments || []).filter((_, index) =>
              kept.has(`queue:${position}:${index}`),
            ),
          },
    ),
    attachmentsNeedReview: false,
    queuePaused: true,
  };
}
