// Local preview state only. No Agent calls, persistence, or production history.
export function createPreviewClock(onStopping) {
  let workTimer = null;
  let stopTimer = null;
  let stopping = false;
  const clearWork = () => {
    clearTimeout(workTimer);
    workTimer = null;
  };
  return {
    get stopping() {
      return stopping;
    },
    get working() {
      return workTimer !== null;
    },
    clearWork,
    work(callback, delay = 3200) {
      if (stopping) return false;
      clearWork();
      workTimer = setTimeout(() => {
        workTimer = null;
        if (!stopping) callback();
      }, delay);
      return true;
    },
    stop(confirm) {
      if (stopping) return false;
      clearWork();
      stopping = true;
      onStopping(true);
      stopTimer = setTimeout(() => {
        stopTimer = null;
        stopping = false;
        onStopping(false);
        confirm();
      }, 1100);
      return true;
    },
    dispose() {
      clearWork();
      clearTimeout(stopTimer);
      stopTimer = null;
      stopping = false;
    },
  };
}

export function canAnswerPreview(task, expectedStatus, stopping) {
  return (
    !stopping &&
    !task.readOnly &&
    !task.interactionExpired &&
    !task.questionSubmission &&
    task.connectionState !== "lost" &&
    !(task.recoveryRead && task.recoveryRead.phase !== "complete") &&
    task.status === expectedStatus
  );
}

export function previewConversationBlocked(task) {
  return Boolean(
    task.accessTest ||
    task.readOnly ||
    task.identityIncomplete ||
    task.attachmentsNeedReview ||
    task.stopping ||
    ["waiting", "pending", "unknown"].includes(task.stopPhase) ||
    task.connectionState === "lost" ||
    task.admissionUnknown ||
    Boolean(task.permissionChange) ||
    task.permissionReconfirmRequired ||
    Boolean(task.configurationChange) ||
    Boolean(task.questionSubmission) ||
    (task.recoveryRead && task.recoveryRead.phase !== "complete") ||
    ["unknown", "recovery", "submitting"].includes(task.status),
  );
}

export function previewQueueGate(
  task,
  { workEnabled = true, sourceAvailable = true, agentAvailable = true },
) {
  if (
    !task.queuePaused &&
    (!workEnabled ||
      !sourceAvailable ||
      !agentAvailable ||
      previewConversationBlocked(task))
  )
    return { queuePaused: true };
  return null;
}

export function canReleasePreviewQueue(
  task,
  { workEnabled = true, sourceAvailable = true, agentAvailable = true } = {},
) {
  return (
    !task.queuePaused &&
    !previewConversationBlocked(task) &&
    !["approval", "question"].includes(task.status) &&
    workEnabled &&
    sourceAvailable &&
    agentAvailable
  );
}

// Give legacy string rows durable identities before opening an editor. Pause
// delivery so editing cannot race the automatic release of the next message.
export function beginPreviewQueueEdit(
  task,
  index,
  nextId = () => crypto.randomUUID(),
) {
  const queue = (task.queue || []).map((item) => ({
    ...(typeof item === "string" ? { text: item } : item),
    id: typeof item === "object" && item.id ? item.id : `queue-${nextId()}`,
  }));
  const item = queue[index];
  if (!item) return null;
  return {
    patch: { queue, queuePaused: true },
    edit: { id: item.id, text: item.text, originalText: item.text },
  };
}

export function savePreviewQueueEdit(task, edit) {
  const item = task.queue?.find((entry) => entry.id === edit.id);
  if (!item) return { error: "这条消息已发送或移除，修改没有应用到其他消息。" };
  if (item.text !== edit.originalText)
    return { error: "这条待发消息已变化，请关闭后重新编辑。" };
  if (!edit.text.trim() && !item.attachments?.length)
    return { error: "请输入消息内容。" };
  return {
    patch: {
      queue: task.queue.map((entry) =>
        entry.id === edit.id ? { ...entry, text: edit.text.trim() } : entry,
      ),
      queuePaused: true,
    },
  };
}

// Answering a permission or question is not a stop confirmation. The local
// fixture still waits for a separate simulated Agent completion afterwards.
export function beginPreviewDecisionResult(task, outcome) {
  if (!["declined", "cancelled"].includes(outcome)) return null;
  if (
    !canAnswerPreview(
      task,
      outcome === "declined" ? "approval" : "question",
      false,
    )
  )
    return null;
  return {
    status: "running",
    resultMode: "decision",
    decisionOutcome: outcome,
    terminalConfirmed: false,
    queuePaused: true,
    stopPhase: null,
    archived: false,
  };
}

// Explicit fixture results only. This never sends a message or repairs the
// Agent's settings. A matching replay unlocks this conversation, not its queue.
export function resolvePreviewRecovery(task, expectedStatus, outcome) {
  if (task.status !== expectedStatus) return null;
  if (expectedStatus === "recovery") {
    if (outcome === "matched")
      return {
        status: "done",
        currentModel: task.model,
        currentEffort: task.effort,
        queuePaused: true,
        terminalConfirmed: true,
        stopPhase: null,
        admissionUnknown: false,
        recoveryResult: "matched",
        permissionReconfirmRequired: true,
      };
    if (["mismatch", "unavailable"].includes(outcome))
      return { queuePaused: true, recoveryResult: outcome };
  }
  if (expectedStatus === "unknown") {
    if (outcome === "unknown")
      return { queuePaused: true, recoveryResult: "unknown" };
    if (["stopped", "completed"].includes(outcome))
      return {
        status: outcome === "stopped" ? "stopped" : "done",
        queuePaused: true,
        stopUnknown: false,
        stopPhase: null,
        admissionUnknown: false,
        unknownReason: null,
        terminalConfirmed: true,
        recoveryResult: outcome,
      };
  }
  return null;
}

const replyFields = [
  "id",
  "agent",
  "status",
  "resultMode",
  "demoKind",
  "previewKind",
  "previewPrompt",
  "prompt",
  "workspaceKind",
  "hasPresetResults",
  "answerDraft",
  "decisionOutcome",
];

export function rememberReply(task, status = task.status) {
  const history = task.replyHistory || [];
  if (!["done", "stopped"].includes(status)) return history;
  const round = task.extraMessages?.length || 0;
  const fields = Object.fromEntries(replyFields.map((key) => [key, task[key]]));
  const message = round ? task.extraMessages[round - 1] : null;
  const reply = {
    ...structuredClone(fields),
    status,
    round,
    replyAttachments: structuredClone(
      (message && typeof message !== "string" ? message.attachments : null) ||
        (!round ? task.sentAttachments : null) ||
        [],
    ),
  };
  return [...history.filter((item) => item.round !== round), reply];
}

export function resumePreview(task) {
  return { archived: false, replyHistory: rememberReply(task) };
}

export function replyAt(task, round) {
  const saved = task.replyHistory?.find((item) => item.round === round);
  if (saved) return saved;
  if (round !== (task.extraMessages?.length || 0)) return null;
  const message = round ? task.extraMessages[round - 1] : null;
  return {
    ...task,
    round,
    replyAttachments:
      (message && typeof message !== "string" ? message.attachments : null) ||
      (!round ? task.sentAttachments : null) ||
      [],
  };
}

export function latestArtifactReply(task) {
  const hasFiles = (reply) =>
    reply.status === "done" &&
    !["simulated", "plan"].includes(reply.resultMode) &&
    (reply.demoKind ||
      reply.hasPresetResults ||
      reply.resultMode === "preset" ||
      ["done", "archived"].includes(reply.id));
  return hasFiles(task)
    ? task
    : [...(task.replyHistory || [])].reverse().find(hasFiles) || task;
}

// Copy only readable transcript text. Controls and collapsed details stay out.
export function readableTranscript(root, title = "") {
  const skip = new Set([
    "BUTTON",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "SVG",
    "SCRIPT",
    "STYLE",
  ]);
  const blocks = new Set([
    "DIV",
    "SECTION",
    "ARTICLE",
    "P",
    "H1",
    "H2",
    "H3",
    "LI",
    "PRE",
    "SUMMARY",
    "SMALL",
  ]);
  const read = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return "";
    if (node.hidden || node.getAttribute?.("aria-hidden") === "true") return "";
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    if (style?.display === "none" || style?.visibility === "hidden") return "";
    if (skip.has(node.tagName)) {
      const step =
        node.classList?.contains("conv-step-toggle") &&
        node.querySelector(".conv-step-title");
      return step ? `${read(step)}\n` : "";
    }
    const children =
      node.tagName === "DETAILS" && !node.open
        ? [...node.children].filter((child) => child.tagName === "SUMMARY")
        : [...node.childNodes];
    const content = children.map(read).join("");
    return blocks.has(node.tagName) ? `\n${content}\n` : content;
  };
  return [
    title,
    root
      ? read(root)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
