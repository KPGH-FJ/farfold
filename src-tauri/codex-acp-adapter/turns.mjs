// Fixed 0.143.0 Turn/item projection. Native raw fields never enter Host history.
import { nativeId, threadMetadata } from "./threads.mjs";
import {
  createInteractions,
  supported,
  id as interactionId,
} from "./interactions.mjs";
const terminal = (s) => ["completed", "failed", "interrupted"].includes(s);
const identifier = (s) =>
  typeof s === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(s);
const text = (s) => typeof s === "string" && Buffer.byteLength(s) <= 65536;
const strings = (v) => Array.isArray(v) && v.length <= 64 && v.every(text);
const same = (a, b) =>
  a &&
  b &&
  a.nativeThreadId === b.nativeThreadId &&
  a.nativeSessionId === b.nativeSessionId &&
  a.cwd === b.cwd;
function checked(value, message) {
  if (!value) throw Error(message);
}
export function projectItem(item) {
  checked(
    item && identifier(item.id) && typeof item.type === "string",
    "Invalid native item identity",
  );
  const base = { id: item.id, type: item.type };
  switch (item.type) {
    case "agentMessage":
      checked(text(item.text), "Invalid assistant text");
      return { ...base, text: item.text };
    case "reasoning":
      checked(
        strings(item.summary) && strings(item.content),
        "Invalid reasoning text",
      );
      return { ...base, summary: item.summary, content: item.content };
    case "commandExecution":
    case "fileChange":
      checked(
        ["inProgress", "completed", "failed", "declined"].includes(item.status),
        "Invalid native tool status",
      );
      // command, output, argv, paths, diffs and errors remain private. No inferred file ownership.
      return { ...base, status: item.status };
    default:
      return null; // Full unknown item is retained privately, never a task state signal.
  }
}
function turn(value) {
  checked(
    value &&
      nativeId(value.id) &&
      ["inProgress", "completed", "failed", "interrupted"].includes(
        value.status,
      ) &&
      ["notLoaded", "summary", "full"].includes(value.itemsView) &&
      Array.isArray(value.items) &&
      value.items.length <= 256 &&
      (value.status === "failed"
        ? value.error && typeof value.error.message === "string"
        : value.error === null),
    "Invalid native Turn",
  );
  return { nativeTurnId: value.id, status: value.status };
}
export function createTurns({
  request,
  launch,
  threads,
  admission,
  enabled,
  retain,
  publish,
  interactionsEnabled = false,
  respond = () => {
    throw Error("Native interaction replies unavailable");
  },
}) {
  let active = null,
    starting = false,
    uncertain = false;
  const early = [],
    retired = new Set();
  const interactions = createInteractions({
    enabled: interactionsEnabled,
    emit,
    respond,
  });
  function context(c) {
    checked(
      c &&
        Object.keys(c).length === 4 &&
        identifier(c.farfoldSessionId) &&
        identifier(c.hostTurnId) &&
        c.workingCopyId === launch.workingCopyId &&
        same(c.thread, threads.bound()),
      "Turn scope differs from original Session",
    );
    return c;
  }
  function emit(value) {
    publish({ context: active.context, nativeTurnId: active.id, ...value });
  }
  function route(frame) {
    if (!active) {
      checked(
        !(supported(frame.method) && frame.id !== undefined),
        "Native request has no bound Turn",
      );
      return;
    }
    if (frame.method === "thread/settings/updated") {
      if (frame.id !== undefined) return;
      const p = frame.params;
      if (p?.threadId !== active.context.thread.nativeThreadId) return;
      const s = p.threadSettings;
      checked(
        s?.cwd === active.context.thread.cwd &&
          ["plan", "default"].includes(s.collaborationMode?.mode) &&
          text(s.collaborationMode?.settings?.model),
        "Unconfirmed native mode",
      );
      active.mode = s.collaborationMode.mode;
      interactions.modeChanged(active.mode);
      return;
    }
    if (interactions.observe(frame, active)) return;
    if (frame.id !== undefined) return;
    const p = frame.params;
    if (!p || p.threadId !== active.context.thread.nativeThreadId) return;
    const id = frame.method.startsWith("turn/") ? p.turn?.id : p.turnId;
    if (id !== active.id) return; // Foreign/late IDs never acquire the current reservation.
    if (frame.method === "turn/started") {
      checked(turn(p.turn).status === "inProgress", "Invalid started state");
      if (!active.started) {
        active.started = true;
        emit({ kind: "started" });
      }
    } else if (frame.method === "turn/completed") {
      const state = turn(p.turn);
      checked(terminal(state.status), "Nonterminal completion");
      for (const item of p.turn.items) {
        const projected = projectItem(item);
        if (projected?.status === "inProgress")
          throw Error("Tool remains active at terminal");
      }
      checked(
        [...active.items.values()].every((i) => i.done),
        "Item lifecycle unresolved at terminal",
      );
      interactions.terminal();
      emit({ kind: "terminal", status: state.status });
      retired.add(active.id);
      checked(retired.size <= 256, "Retired Turn identity pressure");
      active = null;
      uncertain = false;
    } else if (["item/started", "item/completed"].includes(frame.method)) {
      const item = projectItem(p.item);
      if (!item) return;
      const done = frame.method === "item/completed";
      checked(
        Number.isSafeInteger(done ? p.completedAtMs : p.startedAtMs),
        "Missing item timestamp",
      );
      const old = active.items.get(item.id);
      checked(
        !old || (!old.done && done && old.type === item.type),
        "Native item identity/lifecycle changed",
      );
      checked(done ? !!old : !old, "Incomplete native item lifecycle");
      checked(
        !item.status ||
          (done ? item.status !== "inProgress" : item.status === "inProgress"),
        "Native item status mismatch",
      );
      checked(active.items.size < 256 || old, "Native item pressure");
      active.items.set(item.id, { type: item.type, done, native: p.item });
      emit({ kind: done ? "item_completed" : "item_started", item });
    } else {
      const types = {
        "item/agentMessage/delta": "agentMessage",
        "item/reasoning/textDelta": "reasoning",
        "item/reasoning/summaryTextDelta": "reasoning",
      };
      if (!types[frame.method]) return;
      const old = active.items.get(p.itemId);
      checked(
        old && !old.done && old.type === types[frame.method] && text(p.delta),
        "Unbound native text delta",
      );
      const indexKey =
        frame.method === "item/reasoning/textDelta"
          ? "contentIndex"
          : frame.method === "item/reasoning/summaryTextDelta"
            ? "summaryIndex"
            : null;
      checked(
        !indexKey ||
          (Number.isSafeInteger(p[indexKey]) &&
            p[indexKey] >= 0 &&
            p[indexKey] < 64),
        "Invalid reasoning index",
      );
      emit({
        kind: "delta",
        itemId: p.itemId,
        channel: frame.method,
        delta: p.delta,
        index: indexKey ? p[indexKey] : null,
      });
    }
  }
  function observe(frame, serialized) {
    if (
      !frame.method.startsWith("turn/") &&
      !frame.method.startsWith("item/") &&
      !["serverRequest/resolved", "thread/settings/updated"].includes(
        frame.method,
      )
    )
      return false;
    retain(frame, serialized);
    interactions.captured(frame);
    if (starting) {
      checked(early.length < 128, "Early native Turn pressure");
      early.push(frame);
    } else route(frame);
    return true;
  }
  async function command(c) {
    checked(enabled, "Real tasks are disabled");
    checked(
      !uncertain || c.action === "interrupt",
      "Native Turn outcome remains unknown",
    );
    context(c.context);
    if (c.action === "start") {
      checked(
        !active && !starting && text(c.text) && c.text.trim(),
        "Turn not admissible",
      );
      starting = true;
      try {
        if (admission) {
          admission.ticket(c.admission);
          await admission.prepare(c.context.thread, () =>
            threads.readBound(c.context.thread),
          );
          admission.ticket(c.admission);
        }
        const raw = await request("turn/start", {
          threadId: c.context.thread.nativeThreadId,
          input: [{ type: "text", text: c.text, text_elements: [] }],
        });
        retain(raw);
        const state = turn(raw.turn);
        checked(
          state.status === "inProgress" && !retired.has(state.nativeTurnId),
          "Turn start identity/state reused",
        );
        active = {
          context: c.context,
          id: state.nativeTurnId,
          started: false,
          items: new Map(),
          mode: null,
          stopping: false,
          steerIds: new Set(),
          steering: false,
        };
        for (const frame of early) route(frame);
        return state;
      } finally {
        starting = false;
        early.length = 0;
      }
    }
    checked(
      c.action === "interrupt" &&
        active &&
        active.id === c.nativeTurnId &&
        active.context.hostTurnId === c.context.hostTurnId &&
        active.context.farfoldSessionId === c.context.farfoldSessionId,
      "Interrupt target differs",
    );
    checked(!active.stopping, "Stop already requested");
    active.stopping = true;
    interactions.stop();
    const raw = await request("turn/interrupt", {
      threadId: c.context.thread.nativeThreadId,
      turnId: c.nativeTurnId,
    });
    retain(raw);
    checked(
      raw && Object.keys(raw).length === 0,
      "Invalid interrupt acknowledgement",
    );
    return { nativeTurnId: c.nativeTurnId, accepted: true }; // Never terminal evidence.
  }
  async function history(expected) {
    checked(
      enabled && !active && !starting && same(expected, threads.bound()),
      "History target unavailable",
    );
    const raw = await request("thread/read", {
      threadId: expected.nativeThreadId,
      includeTurns: true,
    });
    retain(raw);
    checked(
      same(threadMetadata({ ...raw.thread, turns: [] }, launch), expected),
      "History identity changed",
    );
    checked(
      Array.isArray(raw.thread.turns) && raw.thread.turns.length <= 64,
      "History requires pagination",
    );
    const ids = new Set();
    return raw.thread.turns.map((t) => {
      const state = turn(t);
      checked(
        terminal(state.status) && t.itemsView === "full" && !ids.has(t.id),
        "History incomplete or active",
      );
      ids.add(t.id);
      const items = t.items.map(projectItem).filter(Boolean);
      checked(
        new Set(items.map((i) => i.id)).size === items.length &&
          items.every((i) => i.status !== "inProgress"),
        "History item identity/status invalid",
      );
      return { ...state, items };
    });
  }
  return {
    reply: (c) => {
      context(c.context);
      checked(
        interactionsEnabled &&
          active &&
          active.id === c.nativeTurnId &&
          active.context.hostTurnId === c.context.hostTurnId &&
          active.context.farfoldSessionId === c.context.farfoldSessionId,
        "Interaction target differs",
      );
      return interactions.reply(c, active);
    },
    steer: async (c) => {
      context(c.context);
      const original = active;
      checked(
        interactionsEnabled &&
          active &&
          !uncertain &&
          !active.stopping &&
          !active.steering &&
          active.id === c.nativeTurnId &&
          active.context.hostTurnId === c.context.hostTurnId &&
          active.context.farfoldSessionId === c.context.farfoldSessionId &&
          typeof c.operationId === "string" &&
          interactionId(c.operationId) &&
          !active.steerIds.has(c.operationId) &&
          active.steerIds.size < 256 &&
          text(c.text) &&
          c.text.trim(),
        "Steer target/operation unavailable",
      );
      active.steerIds.add(c.operationId);
      active.steering = true;
      try {
        const raw = await request("turn/steer", {
          threadId: c.context.thread.nativeThreadId,
          expectedTurnId: c.nativeTurnId,
          input: [{ type: "text", text: c.text, text_elements: [] }],
        });
        retain(raw);
        checked(
          active === original &&
            !active.stopping &&
            raw.turnId === c.nativeTurnId,
          "Retired/unconfirmed steer",
        );
        return {
          nativeTurnId: c.nativeTurnId,
          operationId: c.operationId,
          accepted: true,
        };
      } catch (e) {
        if (active === original && !active.stopping) uncertain = true;
        throw e;
      } finally {
        original.steering = false;
      }
    },
    command: async (c) => {
      try {
        return await command(c);
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    history,
    observe,
    pending: () => uncertain || starting || active !== null,
  };
}
