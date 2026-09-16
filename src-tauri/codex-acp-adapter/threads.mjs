// Fixed 0.143.0 metadata-only thread contract. No model/Turn entry points.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, join } from "node:path";
export const nativeId = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((k) => keys.includes(k));
export function threadMetadata(value, launch) {
  if (
    !value ||
    !nativeId(value.id) ||
    !nativeId(value.sessionId) ||
    value.cwd !== launch.cwd ||
    realpathSync(value.cwd) !== value.cwd ||
    value.cliVersion !== "0.143.0" ||
    typeof value.modelProvider !== "string" ||
    !/^[A-Za-z0-9_.:/-]{1,200}$/.test(value.modelProvider) ||
    !Array.isArray(value.turns) ||
    value.turns.length ||
    value.ephemeral !== false ||
    value.forkedFromId !== null ||
    value.parentThreadId !== null ||
    !exactKeys(value.status, ["type"]) ||
    !["idle", "notLoaded"].includes(value.status.type)
  )
    throw Error("Thread metadata outside this lifecycle slice");
  if (value.path !== null) {
    const root = join(launch.codexHome, "sessions");
    if (
      typeof value.path !== "string" ||
      !isAbsolute(value.path) ||
      relative(root, value.path).startsWith("..") ||
      realpathSync(value.path) !== value.path
    )
      throw Error("Thread path outside original profile");
  }
  return {
    nativeThreadId: value.id,
    nativeSessionId: value.sessionId,
    cwd: value.cwd,
    path: value.path,
    status: value.status.type,
    cliVersion: value.cliVersion,
    modelProvider: value.modelProvider,
  };
}

export function createThreads({
  request,
  launch,
  mutationEnabled,
  retain,
  publish,
  admission,
}) {
  let bound = null;
  const known = new Map();
  const early = [];
  let selecting = false;
  function equal(actual, expected) {
    return (
      actual.nativeThreadId === expected.nativeThreadId &&
      actual.nativeSessionId === expected.nativeSessionId &&
      actual.cwd === expected.cwd
    );
  }
  function observe(frame, serialized) {
    if (
      frame.method !== "thread/started" &&
      frame.method !== "thread/status/changed"
    )
      return false;
    // Full native payload remains private; the public channel is an exact typed projection.
    retain(frame, serialized);
    if (selecting) {
      if (early.length >= 16) throw Error("Thread notification pressure");
      early.push(frame);
    } else route(frame);
    return true;
  }
  function route(frame) {
    if (!bound || frame.id !== undefined) return;
    let state;
    if (frame.method === "thread/started") {
      if (!exactKeys(frame.params, ["thread"])) return;
      let candidate;
      try {
        candidate = threadMetadata(frame.params.thread, launch);
      } catch {
        return;
      }
      if (!equal(candidate, bound)) return;
      state = candidate.status;
    } else {
      const p = frame.params;
      if (
        !exactKeys(p, ["threadId", "status"]) ||
        p.threadId !== bound.nativeThreadId ||
        !exactKeys(p.status, ["type"]) ||
        !["idle", "notLoaded"].includes(p.status.type)
      )
        return;
      state = p.status.type;
    }
    publish({ ...bound, status: state, method: frame.method });
  }
  async function command(command) {
    if (!exactKeys(command, ["action", "thread"]))
      throw Error("Invalid thread operation");
    if (typeof launch.workingCopyId !== "string" || !launch.workingCopyId)
      throw Error("Working Copy binding missing");
    if (command.action === "list") {
      const raw = await request("thread/list", {
        limit: 10,
        cwd: launch.cwd,
        useStateDbOnly: true,
      });
      retain(raw);
      if (
        !Array.isArray(raw.data) ||
        raw.data.length > 10 ||
        raw.nextCursor !== null
      )
        throw Error("Thread list requires unsupported pagination");
      const data = raw.data.map((t) => threadMetadata(t, launch));
      for (const t of data) known.set(t.nativeThreadId, t);
      return { data, thread: null };
    }
    const expected = command.thread;
    if (
      command.action !== "start" &&
      (!expected ||
        !nativeId(expected.nativeThreadId) ||
        !known.has(expected.nativeThreadId) ||
        !equal(expected, known.get(expected.nativeThreadId)))
    )
      throw Error("Original listed thread identity required");
    if (
      ["start", "resume"].includes(command.action) &&
      (!mutationEnabled || bound)
    )
      throw Error("Thread mutation unavailable or connection already bound");
    if (!["start", "resume", "read"].includes(command.action))
      throw Error("Unsupported thread operation");
    selecting = command.action !== "read";
    try {
      const modelParams =
        command.action === "start" ? await admission.beforeStart() : {};
      if (command.action === "resume") admission.requireSelection();
      const raw = await request(
        `thread/${command.action}`,
        command.action === "start"
          ? {
              cwd: launch.cwd,
              ephemeral: false,
              experimentalRawEvents: false,
              sandbox: "read-only",
              approvalPolicy: "never",
              environments: [],
              ...modelParams,
            }
          : command.action === "read"
            ? { threadId: expected.nativeThreadId, includeTurns: false }
            : { threadId: expected.nativeThreadId, excludeTurns: true },
      );
      retain(raw);
      const thread = threadMetadata(raw.thread, launch);
      if (expected && !equal(thread, expected))
        throw Error("Native thread identity changed");
      if (
        command.action !== "read" &&
        (raw.cwd !== launch.cwd ||
          !Array.isArray(raw.runtimeWorkspaceRoots) ||
          raw.runtimeWorkspaceRoots.some((p) => p !== launch.cwd))
      )
        throw Error("Native workspace changed");
      known.set(thread.nativeThreadId, thread);
      if (selecting) {
        admission.confirm(raw, thread);
        bound = thread;
        for (const frame of early) route(frame);
      }
      return {
        data: [],
        thread,
        model: selecting ? admission.snapshot().actual : null,
      };
    } finally {
      selecting = false;
      early.length = 0;
    }
  }
  return {
    command,
    observe,
    bound: () => bound,
    readBound: async (expected) => {
      if (!bound || !equal(expected, bound)) throw Error("Unbound model read");
      const raw = await request("thread/read", {
        threadId: expected.nativeThreadId,
        includeTurns: false,
      });
      retain(raw);
      if (!equal(threadMetadata(raw.thread, launch), bound))
        throw Error("Thread identity drift");
      return raw;
    },
  };
}
