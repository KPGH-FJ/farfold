import {
  cancelAgentJob,
  confirmAgentJobStopped,
  continueAgentJob,
} from "./access-jobs.js";

export const ACCESS_TEST_PROMPT = "请只回复：已连接。";

function updateFromJob(task, job, result, visibleId) {
  const phase = job?.status || result?.status;
  const status = job
    ? phase === "approval"
      ? "approval"
      : phase === "unknown"
        ? "unknown"
        : "running"
    : phase === "passed"
      ? "done"
      : phase === "failed"
        ? "failed"
        : "stopped";
  const label = job?.label || result?.message || "测试已结束。";
  if (
    task.accessTest.phase === phase &&
    task.accessTest.label === label &&
    task.status === status
  )
    return task;
  return {
    ...task,
    status,
    unknownReason: status === "unknown" ? "test" : undefined,
    simulatePending: false,
    accessTest: {
      ...task.accessTest,
      phase,
      label,
      result: job ? null : phase,
    },
    ...(status === "done" && task.status !== "done"
      ? { unread: visibleId !== task.id }
      : {}),
  };
}

// This is a display projection of the existing access job, not a second timer
// or request. Every job owns exactly one fixed test message and identity.
export function syncAccessTestTasks(tasks, agents, services, visibleId) {
  let next = tasks;
  for (const agent of agents) {
    const job = agent.accessJob?.type === "test" ? agent.accessJob : null;
    const result =
      agent.lastAccessResult?.type === "test" ? agent.lastAccessResult : null;
    const id = job?.id || result?.id;
    if (!id) continue;
    const index = next.findIndex((task) => task.id === id && task.accessTest);
    if (index < 0) {
      if (!job) continue;
      const selection = structuredClone(job.selection || {});
      const service =
        selection.access === "api"
          ? services.find((item) => item.id === selection.serviceId)
          : null;
      const task = {
        id,
        title: `${agent.name} · 连接测试`,
        prompt: ACCESS_TEST_PROMPT,
        agent: agent.name,
        agentId: agent.id,
        model: selection.model || "",
        effort: selection.effort || "",
        accessMode: selection.access || "existing",
        serviceId: service?.id || null,
        source: service?.name || "沿用已有设置",
        serviceSnapshot: service ? structuredClone(service) : null,
        folder: selection.folder || "",
        project: selection.folder || "普通对话",
        group: "",
        status: "running",
        draft: "",
        queue: [],
        time: "刚刚",
        simulatePending: false,
        accessTest: {
          jobId: job.id,
          agentId: agent.id,
          phase: null,
          label: null,
          result: null,
        },
      };
      next = [updateFromJob(task, job, null, visibleId), ...next];
    } else {
      const updated = updateFromJob(next[index], job, result, visibleId);
      if (updated !== next[index])
        next = next.map((task, i) => (i === index ? updated : task));
    }
  }
  return next;
}

// All controls resolve the exact same job. Stale record actions never act on a
// later test of the same Agent.
export function actOnAccessTest(agents, id, action, now = Date.now()) {
  return agents.map((agent) => {
    const job = agent.accessJob;
    if (job?.type !== "test" || job.id !== id) return agent;
    if (action === "stop" || action === "reject")
      return cancelAgentJob(agent, now);
    if (action === "approve") return continueAgentJob(agent, id, now);
    if (action === "confirm-stopped") return confirmAgentJobStopped(agent, id);
    return agent;
  });
}
