import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { ToolStep } from "../components/thread-items";
import { applyUpdate, freshThreadState, paneCards, threads } from "./sessions";
import type { ThreadState, ToolCallView } from "./session_types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  h.invoke.mockReset();
});

function tool(state: ThreadState, id: string): ToolCallView {
  const item = state.items.find(
    (item) => item.kind === "tool" && item.call.toolCallId === id,
  );
  if (item?.kind !== "tool") throw new Error("missing tool");
  return item.call;
}

it("restores tool content without claiming replay time as execution time", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  let channel!: { onmessage: (event: unknown) => void };
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd !== "session_open") return [];
    channel = args.channel;
    channel.onmessage({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "old",
        title: "sleep 60",
        kind: "execute",
        status: "in_progress",
      },
    });
    clock.mockReturnValue(100_100);
    channel.onmessage({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "old",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "kept" } }],
      },
    });
    channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Completed command" },
      },
    });
    channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return { cwd: "/p", nativeSessionId: "history-time", resumed: true };
  });
  const state = await threads.open({
    agentId: "fixture",
    cwd: "/p",
    nativeSessionId: "history-time",
  });
  const old = tool(state, "old");
  expect(old.startedAt).toBe(0);
  expect(old.endedAt).toBeUndefined();
  expect(paneCards(state)).toEqual([
    {
      kind: "command",
      title: "sleep 60",
      output: "kept",
      failed: false,
      time: 0,
    },
  ]);
  expect(renderToStaticMarkup(<ToolStep call={old} />)).toContain("耗时未知");

  // A later update cannot turn an unknown historical start into a duration.
  clock.mockReturnValue(130_000);
  channel.onmessage({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "old",
      status: "completed",
    },
  });
  expect(old.endedAt).toBeUndefined();
  expect(renderToStaticMarkup(<ToolStep call={old} />)).toContain("耗时未知");

  // A new live tool in the same resumed conversation still has valid timing.
  channel.onmessage({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "live",
      status: "in_progress",
    },
  });
  clock.mockReturnValue(132_400);
  channel.onmessage({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "live",
      status: "completed",
    },
  });
  expect(
    renderToStaticMarkup(<ToolStep call={tool(state, "live")} />),
  ).toContain("2.4s");
});

it.each(["completed", "failed"])(
  "does not invent elapsed time for a tool first seen as %s",
  (status) => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const state = freshThreadState("fixture:/p:done", "fixture", "/p", "done");
    applyUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: "done",
      status,
    });
    expect(
      renderToStaticMarkup(<ToolStep call={tool(state, "done")} />),
    ).toContain("耗时未知");
  },
);

it("keeps reported tool logs available without requiring a completion row", () => {
  const state = freshThreadState("fixture:/p:logs", "fixture", "/p", "logs");
  applyUpdate(state, {
    sessionUpdate: "tool_call",
    toolCallId: "read-log",
    kind: "read",
    title: "Read report",
    status: "failed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "File was not found" },
      },
    ],
  });
  expect(paneCards(state)).toEqual([
    expect.objectContaining({
      kind: "log",
      title: "Read report",
      output: "File was not found",
      failed: true,
    }),
  ]);
  expect(state.items.some((item) => item.kind === "settled")).toBe(false);
});

it("waits for the matching replay boundary before replacing a restored conversation", async () => {
  const prior = threads.markOpenFailed(
    "fixture:/p:boundary",
    "fixture",
    "/p",
    "boundary",
    "retry",
  );
  prior.items.push({
    kind: "agent",
    id: "prior",
    text: "Prior history",
    streaming: false,
    time: 0,
  });
  let channel!: { onmessage: (event: unknown) => void };
  let token!: string;
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd !== "session_open") return [];
    channel = args.channel;
    token = args.openToken;
    return { cwd: "/p", nativeSessionId: "boundary", resumed: true };
  });
  let finished = false;
  const opening = threads
    .open({ agentId: "fixture", cwd: "/p", nativeSessionId: "boundary" })
    .then((state) => {
      finished = true;
      return state;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  expect(threads.thread(prior.key)).toBe(prior);
  channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Complete history" },
    },
  });
  channel.onmessage({
    kind: "session_history_complete",
    openToken: "another-open",
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  channel.onmessage({ kind: "session_history_complete", openToken: token });
  const restored = await opening;
  expect(restored.items).toEqual([
    expect.objectContaining({ text: "Complete history", time: 0 }),
  ]);
});

it("retains prior history when an acknowledged load has no readable conversation", async () => {
  const prior = threads.markOpenFailed(
    "fixture:/p:empty-body",
    "fixture",
    "/p",
    "empty-body",
    "retry",
  );
  prior.items.push({
    kind: "agent",
    id: "prior-body",
    text: "Keep me",
    streaming: false,
    time: 0,
  });
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd !== "session_open") return [];
    args.channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return { cwd: "/p", nativeSessionId: "empty-body", resumed: true };
  });
  await expect(
    threads.open({
      agentId: "fixture",
      cwd: "/p",
      nativeSessionId: "empty-body",
    }),
  ).rejects.toBeTruthy();
  expect(threads.thread(prior.key)).toBe(prior);
  expect(prior.items).toEqual([expect.objectContaining({ text: "Keep me" })]);
  expect(prior.openError).toBeTruthy();
});

it("keeps a partial replay unavailable when its completion marker times out", async () => {
  vi.useFakeTimers();
  let channel!: { onmessage: (event: unknown) => void };
  let token!: string;
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd !== "session_open") return [];
    channel = args.channel;
    token = args.openToken;
    channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Partial only" },
      },
    });
    return { cwd: "/p", nativeSessionId: "incomplete-replay", resumed: true };
  });
  const opening = threads.open({
    agentId: "fixture",
    cwd: "/p",
    nativeSessionId: "incomplete-replay",
  });
  const rejected = expect(opening).rejects.toBeTruthy();
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  const failed = threads.thread("fixture:/p:incomplete-replay")!;
  expect(failed.items).toEqual([]);
  expect(failed.openError).toBeTruthy();
  channel.onmessage({ kind: "session_history_complete", openToken: token });
  expect(failed.openError).toBeTruthy();
});

it("accepts a complete history containing only an actual attachment message", async () => {
  h.invoke.mockImplementation(async (cmd, args) => {
    if (cmd !== "session_open") return [];
    args.channel.onmessage({
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      },
    });
    args.channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    return { cwd: "/p", nativeSessionId: "attachment-history", resumed: true };
  });
  const state = await threads.open({
    agentId: "fixture",
    cwd: "/p",
    nativeSessionId: "attachment-history",
  });
  expect(state.items).toEqual([
    expect.objectContaining({
      kind: "user",
      text: "",
      attachments: [
        expect.objectContaining({ kind: "image", data: "aGVsbG8=" }),
      ],
    }),
  ]);
});
