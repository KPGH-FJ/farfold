// Design-only rules shared by the conversation, navigation and library.
// These objects are preview fixtures, never a second product history store.
const IDENTITY = [
  "agent",
  "accessMode",
  "serviceId",
  "source",
  "model",
  "effort",
  "folder",
  "serviceSnapshot",
];
const terminal = (task) => ["done", "stopped", "failed"].includes(task.status);
export function conversationState(task = {}) {
  const stopping = ["waiting", "unknown"].includes(task.stopPhase);
  const pending = ["approval", "question"].includes(task.status);
  const restoring = Boolean(
    task.recoveryRead && task.recoveryRead.phase !== "complete",
  );
  const attention =
    Boolean(task.identityIncomplete) ||
    Boolean(task.attachmentsNeedReview) ||
    pending ||
    stopping ||
    ["unknown", "recovery"].includes(task.status) ||
    restoring ||
    task.connectionState === "lost" ||
    Boolean(task.admissionUnknown);
  const permissionUnknown = task.permissionChange?.phase === "unknown";
  const permissionPending = task.permissionChange?.phase === "pending";
  const needsAttention = attention || permissionUnknown;
  const running =
    !needsAttention &&
    (["running", "submitting"].includes(task.status) || permissionPending);
  const queue = Boolean(task.queue?.length);
  const archiveReason = needsAttention
    ? "请先处理待回应或未确认的工作"
    : running
      ? "工作结束后才可归档"
      : queue
        ? "请先处理待发消息"
        : null;
  return {
    attention: needsAttention,
    running,
    idle: !needsAttention && !running,
    category: needsAttention ? "attention" : running ? "running" : "idle",
    label: needsAttention ? "需要你" : running ? "在跑" : "空闲",
    canArchive: !archiveReason,
    archiveReason,
  };
}
export const canArchiveConversation = (task) =>
  conversationState(task).canArchive;

export function applyConversationPatch(task, patch) {
  const next = { ...task, ...patch };
  const fixed =
    task.fixedIdentity ||
    (task.status !== "draft"
      ? Object.fromEntries(IDENTITY.map((key) => [key, task[key]]))
      : null);
  if (fixed) {
    for (const key of IDENTITY) {
      const value = fixed[key];
      if (value !== undefined && value !== null && value !== "")
        next[key] = value;
      else if (
        patch[key] !== undefined &&
        patch[key] !== task[key] &&
        !patch.confirmMissingIdentity
      )
        next[key] = task[key];
    }
    next.fixedIdentity = { ...fixed };
    if (patch.confirmMissingIdentity)
      for (const key of IDENTITY) {
        if (
          fixed[key] === undefined ||
          fixed[key] === null ||
          fixed[key] === ""
        )
          next.fixedIdentity[key] = next[key];
      }
  } else if (next.status !== "draft")
    next.fixedIdentity = Object.fromEntries(
      IDENTITY.map((key) => [key, structuredClone(next[key])]),
    );
  delete next.confirmMissingIdentity;
  if (
    task.terminalConfirmed &&
    terminal(task) &&
    patch.status === "unknown" &&
    !patch.reviewScenario
  ) {
    next.status = task.status;
    next.admissionUnknown = false;
    next.unknownReason = undefined;
    next.queuePaused = task.queuePaused;
    next.stopPhase = task.stopPhase;
  }
  if (patch.status === "running" && terminal(task)) {
    next.terminalConfirmed = false;
    next.stopPhase = null;
    next.interactionExpired = false;
  }
  if (patch.archived === true && !canArchiveConversation(task))
    next.archived = task.archived || false;
  delete next.reviewScenario;
  return next;
}

export function requestPreviewEvent(
  task,
  type,
  requestId = task.previewRequestId,
) {
  if (!requestId || requestId !== task.previewRequestId)
    return { eventNote: "旧请求的迟到结果已忽略，当前工作不受影响。" };
  if (
    ["unknown", "transport-error", "accepted"].includes(type) &&
    task.terminalConfirmed
  )
    return {
      eventNote: "已收到明确完成结果，迟到回执不会改写它。",
      admissionUnknown: false,
    };
  if (["completed", "stopped"].includes(type))
    return {
      status: type === "completed" ? "done" : "stopped",
      terminalConfirmed: true,
      admissionUnknown: false,
      stopPhase: null,
      queuePaused: true,
      eventNote: "结果已确认；待发消息仍保留，由你决定是否继续。",
    };
  if (type === "accepted")
    return {
      status: "running",
      admissionUnknown: false,
      eventNote: "已确认接纳，等待执行结果。",
    };
  return {
    status: "unknown",
    admissionUnknown: true,
    unknownReason: "admission",
    queuePaused: true,
    eventNote: "结果尚未确认，保留原请求，不自动重发。",
  };
}

export function recoveryPreviewEvent(
  task,
  type,
  readId = task.recoveryRead?.id,
) {
  const read = task.recoveryRead;
  if (!read || read.id !== readId) return null;
  if (read.phase === "complete") return null;
  const next = { ...read };
  if (type === "receipt") next.receipt = true;
  if (type === "partial") next.received = Math.max(1, next.received || 0);
  if (type === "body-complete") {
    next.bodyComplete = true;
    next.received = 3;
  }
  if (type === "identity-matched") next.identityStatus = "matched";
  if (type === "identity-mismatch") next.identityStatus = "mismatch";
  if (["failed", "empty", "unsupported"].includes(type)) next.phase = type;
  else if (!next.phase || next.phase === "loading")
    next.phase =
      next.receipt && next.bodyComplete && next.identityStatus === "matched"
        ? "complete"
        : "loading";
  const completed = next.phase === "complete";
  return {
    recoveryRead: next,
    status: completed ? "done" : "recovery",
    queuePaused: true,
    ...(completed
      ? {
          // A separate simulated settings result is required. Body delivery
          // alone cannot erase a previously observed model or effort drift.
          currentModel: task.model,
          currentEffort: task.effort,
          terminalConfirmed: true,
        }
      : {}),
  };
}

export function feedbackVersion(file) {
  const text = file.after ?? file.content ?? "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return file.version || `content-${(hash >>> 0).toString(16)}`;
}
export const feedbackKey = (file) =>
  JSON.stringify([file.path, feedbackVersion(file)]);
export function updateFeedback(task, file, patch) {
  const key = feedbackKey(file);
  const existing = task.feedbackDrafts?.[key] || {
    path: file.path,
    version: feedbackVersion(file),
    versionLabel: file.versionLabel || "所看内容",
    text: "",
    line: "",
  };
  return {
    feedbackDrafts: {
      ...task.feedbackDrafts,
      [key]: { ...existing, ...patch },
    },
  };
}
export function takeFeedback(task, key) {
  const note = task.feedbackDrafts?.[key];
  if (!note?.text?.trim()) return null;
  const value = `关于 ${note.path}（${note.versionLabel || "所看内容"}${note.line ? `，第 ${note.line} 行` : ""}）：\n${note.text.trim()}`;
  const drafts = { ...task.feedbackDrafts };
  delete drafts[key];
  return {
    draft: [task.draft?.trim(), value].filter(Boolean).join("\n\n"),
    feedbackDrafts: drafts,
  };
}
