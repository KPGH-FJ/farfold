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
    { kind: "command", title: "sleep 60", output: "kept", time: 0 },
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
