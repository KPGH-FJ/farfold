// Explicit local fixtures for the proposed import flow. No disk or Agent access.
export const IMPORT_STATUS = {
  continuable: { label: "可继续", tone: "green" },
  readOnly: { label: "仅查看", tone: "" },
  missingLocation: { label: "位置缺失", tone: "amber" },
  unreadable: { label: "不可读取", tone: "amber" },
};

export const importIdentity = (agentId, externalId) =>
  JSON.stringify([agentId, externalId]);

export function importAgentReady(agent) {
  return Boolean(
    agent && (agent.connected === true || agent.demoReady === true),
  );
}

// One local action at a time. Closing can cancel a delay, but cannot revoke a
// batch already handed to the parent. Keep that action locked until it settles.
export function createImportOperation(onBusy) {
  let current = null;
  return {
    get active() {
      return current;
    },
    isCurrent(operation) {
      return current === operation;
    },
    begin(kind, owner, callback, delay) {
      if (current) return false;
      const operation = { kind, owner, stage: "waiting", timer: null };
      current = operation;
      onBusy(kind);
      operation.timer = setTimeout(() => {
        operation.timer = null;
        if (current === operation) callback(operation);
      }, delay);
      return true;
    },
    commit(operation) {
      if (current !== operation) return false;
      operation.stage = "committing";
      onBusy("committing");
      return true;
    },
    finish(operation) {
      if (current !== operation) return false;
      clearTimeout(operation.timer);
      current = null;
      onBusy(null);
      return true;
    },
    cancel() {
      if (current?.stage === "committing") return false;
      if (current) clearTimeout(current.timer);
      current = null;
      onBusy(null);
      return true;
    },
    dispose() {
      if (current) clearTimeout(current.timer);
      current = null;
    },
  };
}

export function captureImportIdentity(agent) {
  // The selected Agent locates histories; its current settings are not evidence
  // of the settings used by any historical conversation.
  return {
    agentId: agent.id || agent.name,
    agent: agent.name,
  };
}

export function addedImportAgents(agents) {
  return agents.filter(
    (agent) =>
      agent.added || agent.connected || agent.demoReady || agent.setupComplete,
  );
}

export function initialImportDraft() {
  return {
    selected: [],
    query: "",
    previewId: null,
    records: [],
    lookup: "idle",
    example: "normal",
    step: 1,
  };
}

export function exampleConversations(
  agent,
  identity = captureImportIdentity(agent),
) {
  const examples = [
    {
      externalId: "sample-weekend",
      originalSelection: {
        model: "历史示例模型 A",
        effort: "标准",
        source: "沿用已有设置",
        accessMode: "existing",
      },
      title: "周末想去海边走走",
      updated: "今天 10:24",
      status: "continuable",
      folder: "",
      preview: "两天一夜，尽量少赶路。",
      messages: [
        {
          role: "user",
          text: "周末想去海边住一晚，公共交通出发，不想把行程排满。",
        },
        {
          role: "assistant",
          text: "先把范围收在车程两小时以内。第一天下午抵达、沿海边散步；第二天慢慢吃早餐，午后返程。具体目的地、天气与车次还需要确认。",
        },
        { role: "user", text: "两个人，住宿希望安静一点。" },
        {
          role: "assistant",
          text: "已记下两人出行和安静住宿的偏好。下一步可以按出发城市比较两三个候选地点，再核对交通与费用。",
        },
      ],
    },
    {
      externalId: "sample-search",
      originalSelection: {
        model: "历史示例模型 B",
        effort: "深入",
        source: "沿用已有设置",
        accessMode: "existing",
      },
      title: "搜索框的键盘操作",
      updated: "昨天 17:40",
      status: "continuable",
      folder: "~/Projects/farfold",
      preview: "确认焦点和 Esc 的预期行为。",
      messages: [
        { role: "user", text: "先帮我梳理搜索框的键盘操作，不要修改代码。" },
        {
          role: "assistant",
          text: "可以先确认三个动作：打开后聚焦输入、方向键移动结果、Esc 关闭并把焦点还给原入口。还需要决定无结果时 Enter 的行为。这里尚未修改文件或运行检查。",
        },
      ],
    },
    {
      externalId: "sample-reading",
      title: "读书笔记：给自己留一点余地",
      updated: "9 月 21 日",
      status: "readOnly",
      folder: "",
      preview: "保留了原文和整理后的三段摘要。",
      reason:
        "这份示例没有提供原模型，暂不能确认可继续。可以先查看历史，或另开对话。",
      messages: [
        {
          role: "user",
          text: "把这段笔记整理成三段，保留我原本不确定的语气。",
        },
        {
          role: "assistant",
          text: "第一段写观察：我发现安排越满，越难留心自己真正想做什么。\n\n第二段写尝试：也许可以先把一天留出一段不安排任务的时间。\n\n第三段保留疑问：这会不会更从容，还需要在接下来的生活里慢慢验证。",
        },
      ],
    },
    {
      externalId: "sample-old-site",
      originalSelection: {
        model: "历史示例模型 B",
        effort: "深入",
        source: "沿用已有设置",
        accessMode: "existing",
      },
      title: "旧网站的介绍文案",
      updated: "9 月 18 日",
      status: "missingLocation",
      folder: "/Volumes/Archive/old-website",
      preview: "历史可读，但原文件位置已经找不到。",
      reason: "原文件位置无法使用。可以保留历史；选择其他位置只能开启新对话。",
      messages: [
        { role: "user", text: "为旧网站整理一版简短介绍，先给文字建议。" },
        {
          role: "assistant",
          text: "建议用一句话说明网站记录什么，再给读者两个可以开始浏览的入口。原文件尚未修改；需要先确认哪些内容仍然有效。",
        },
      ],
    },
    {
      externalId: "sample-unreadable",
      title: "一段暂时无法读取的对话",
      updated: "9 月 16 日",
      status: "unreadable",
      folder: "",
      preview: "只读到了标题，没有取得正文。",
      reason:
        "示例模拟正文读取失败，当前不能加入。重试不会把缺失正文当作空对话。",
      messages: [],
    },
    {
      externalId: "sample-recap",
      originalSelection: {
        model: "历史示例模型 A",
        effort: "标准",
        source: "沿用已有设置",
        accessMode: "existing",
      },
      title: "季度复盘，先整理事实",
      updated: "9 月 14 日",
      status: "continuable",
      folder: "",
      preview: "区分已经完成的事和下一步想法。",
      failOnce: true,
      messages: [
        {
          role: "user",
          text: "帮我把季度复盘分成事实、收获和还没想清楚的问题。",
        },
        {
          role: "assistant",
          text: "可以把已完成的事项与证据放在第一部分；第二部分只写这些经历带来的具体认识；最后列出仍需观察的问题。下一步需要你补充实际完成的事项，不先替你编造结论。",
        },
      ],
    },
  ];
  return examples.map((record) => ({
    ...identity,
    ...record,
    model: record.originalSelection?.model || "未提供原模型",
    originalModelKnown: Boolean(record.originalSelection?.model),
    effort: record.originalSelection?.effort || "未提供原推理选择",
    source: record.originalSelection?.source || "未提供原来源",
    accessMode: record.originalSelection?.accessMode || "unknown",
    key: importIdentity(identity.agentId, record.externalId),
    ...(record.status === "continuable" && !record.originalSelection?.model
      ? {
          status: "readOnly",
          reason:
            "这份示例没有提供原模型，暂不能确认可继续。可以先查看历史，或另开对话。",
        }
      : {}),
  }));
}

export function importedKey(task) {
  return (
    task.importKey ||
    (task.imported && task.agentId && task.externalConversationId
      ? importIdentity(task.agentId, task.externalConversationId)
      : null)
  );
}

export function lookupExample(
  agent,
  example = "normal",
  identity,
  existing = [],
) {
  if (!importAgentReady(agent))
    return {
      lookup: "failed",
      lookupError:
        "这个 Agent 尚未准备好。完成连接后再查找；本次没有读取对话。",
    };
  if (example === "unsupported") return { lookup: "unsupported" };
  if (example === "error")
    return {
      lookup: "failed",
      lookupError: "示例模拟对话列表读取失败。已有选择保留，可以重试。",
    };
  return {
    lookup: "loaded",
    records:
      example === "empty"
        ? []
        : exampleConversations(agent, identity).map((record) => {
            const saved = existing.find(
              (task) => importedKey(task) === record.key,
            );
            if (!saved) return record;
            return {
              ...record,
              model: saved.model,
              effort: saved.effort,
              source: saved.source,
              accessMode: saved.accessMode,
              folder: saved.folder,
              status:
                saved.importStatus ||
                (saved.readOnly ? "readOnly" : record.status),
              reason: saved.readOnlyReason || record.reason,
              messages: saved.importedMessages || record.messages,
            };
          }),
  };
}

export function visibleImportPreview(records, query, previewId) {
  const visible = filterImportRecords(records, query);
  return (
    visible.find((record) => record.externalId === previewId) ||
    visible[0] ||
    null
  );
}

export function joinedImportTasks(tasks, accepted = []) {
  // Current parent data wins over a temporary acknowledgement snapshot.
  return new Map(
    [...accepted, ...tasks]
      .filter((task) => importedKey(task))
      .map((task) => [importedKey(task), task]),
  );
}

export function isImportable(record, tasks = []) {
  return (
    record.status !== "unreadable" &&
    Array.isArray(record.messages) &&
    record.messages.some(
      (message) =>
        ["user", "assistant"].includes(message.role) &&
        typeof message.text === "string" &&
        Boolean(message.text.trim()),
    ) &&
    !tasks.some((task) => importedKey(task) === record.key)
  );
}

export function filterImportRecords(records, query = "") {
  const value = query.trim().toLocaleLowerCase();
  return records.filter(
    (record) =>
      !value ||
      `${record.title} ${record.preview} ${record.folder}`
        .toLocaleLowerCase()
        .includes(value),
  );
}

export function toggleVisibleSelection(selected, visible, tasks = []) {
  const keys = visible
    .filter((record) => isImportable(record, tasks))
    .map((record) => record.key);
  const allSelected =
    keys.length > 0 && keys.every((key) => selected.includes(key));
  return allSelected
    ? selected.filter((key) => !keys.includes(key))
    : [...new Set([...selected, ...keys])];
}

export function taskFromImport(record) {
  const readOnly = record.status !== "continuable";
  return {
    id: `imported-${encodeURIComponent(record.agentId)}-${encodeURIComponent(record.externalId)}`,
    title: record.title,
    agent: record.agent,
    agentId: record.agentId,
    model: record.model,
    effort: record.effort,
    source: record.source,
    accessMode: record.accessMode,
    serviceId: record.serviceId,
    serviceSnapshot: record.serviceSnapshot
      ? structuredClone(record.serviceSnapshot)
      : undefined,
    lifecycle: "established",
    status: "done",
    time: "刚刚",
    unread: false,
    archived: false,
    pinned: false,
    project: record.folder || "未分组",
    folder: record.folder || "",
    group: "",
    prompt:
      record.messages.find((message) => message.role === "user")?.text ||
      record.title,
    draft: "",
    queue: [],
    attachments: [],
    imported: true,
    importKey: record.key,
    externalConversationId: record.externalId,
    importStatus: record.status,
    importedAt: "本次预览",
    importedMessages: structuredClone(record.messages),
    readOnly,
    readOnlyReason: readOnly ? record.reason : "",
    importedLocationMissing: record.status === "missingLocation",
    importedSourceLabel: "Agent 已有对话 · 本地示例",
  };
}

export function planImport(records, selected, existingTasks, attempts = {}) {
  const chosen = new Set(selected);
  const seen = new Set(existingTasks.map(importedKey).filter(Boolean));
  const tasks = [],
    failures = [],
    skipped = [],
    nextAttempts = { ...attempts };
  for (const record of records) {
    if (!chosen.has(record.key)) continue;
    if (seen.has(record.key)) {
      skipped.push(record.key);
      continue;
    }
    if (!isImportable(record)) {
      failures.push({
        key: record.key,
        title: record.title,
        message: "正文不可读取，尚未加入。",
      });
      continue;
    }
    nextAttempts[record.key] = (attempts[record.key] || 0) + 1;
    if (record.failOnce && nextAttempts[record.key] === 1) {
      failures.push({
        key: record.key,
        title: record.title,
        message: "此条示例加入失败，选择与正文已保留，可以单独重试。",
      });
      continue;
    }
    seen.add(record.key);
    tasks.push(taskFromImport(record));
  }
  return { tasks, failures, skipped, attempts: nextAttempts };
}

export function mergeImportedTasks(existing, incoming) {
  const keys = new Set(existing.map(importedKey).filter(Boolean));
  const added = incoming.filter((task) => {
    const key = importedKey(task);
    if (!key || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return [...added, ...existing];
}
