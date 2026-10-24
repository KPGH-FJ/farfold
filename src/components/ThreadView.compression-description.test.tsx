import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
import { freshThreadState } from "../runtime/session_projection";
import { applySessionEvent } from "../runtime/session_event_projection";
import { hasActiveCompaction } from "../runtime/compaction_activity";
import { ThreadView } from "./ThreadView";
import { TranscriptSearchContext } from "./transcript-search";

const state = () =>
  freshThreadState("description", "any-agent", "/controlled", "native");
type State = ReturnType<typeof state>;
const labels = {
  progress: "正在整理上下文",
  done: "上下文已整理",
  noop: "无需整理上下文",
};
const prefix = "Agent 提供的整理状态";
function render(s: State) {
  return renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={true}>
      <ThreadView
        thread={s}
        active
        agents={[]}
        onGoSettings={() => {}}
        onOpened={() => {}}
      />
    </TranscriptSearchContext.Provider>,
  );
}
function receive(
  s: State,
  meta: unknown,
  live = true,
  text = "Original Agent body retained",
) {
  const event = {
    sessionId: s.nativeSessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      _meta: meta,
    },
  };
  applySessionEvent(s, event, live);
  return event;
}
it.each(["progress", "done", "noop"] as const)(
  "explains the official %s metadata shape without an ID, retaining body and raw details",
  (phase) => {
    const s = state();
    const meta = {
      source: "slash_command",
      contextCompression: { phase },
      futureField: "extension-preserved",
    };
    receive(s, meta);
    const before = structuredClone(s);
    const html = render(s);
    expect(html).toContain(prefix);
    expect(html).toContain(labels[phase]);
    expect(html).toContain("Original Agent body retained");
    expect(html).toContain("extension-preserved");
    expect(html).toContain("contextCompression");
    if (phase === "noop") expect(html).not.toContain(labels.done);
    expect(s).toEqual(before);
    expect(s.items.some((item) => item.kind === "compaction")).toBe(false);
    expect(hasActiveCompaction(s)).toBe(false);
  },
);
it.each(["progress", "done", "noop"] as const)(
  "describes historical %s without granting live activity or request authority",
  (phase) => {
    const s = state();
    receive(
      s,
      { source: "slash_command", contextCompression: { phase } },
      false,
    );
    for (const item of s.items) if (item.kind === "agent") item.time = 0;
    const before = structuredClone(s);
    expect(render(s)).toContain(prefix);
    expect(render(s)).toContain(labels[phase]);
    expect(s).toEqual(before);
    expect(s.running).toBe(false);
    expect(s.compactionActivity).toBe(before.compactionActivity);
    expect(hasActiveCompaction(s)).toBe(false);
    expect(s.connectionOutcomeUnknown).toBe(false);
  },
);
it("shows only supplied finite token counts and their supplied estimation flags, without calculating savings", () => {
  const s = state();
  receive(s, {
    source: "slash_command",
    contextCompression: {
      phase: "done",
      originalTokenCount: 1200,
      newTokenCount: 800,
      originalTokenCountIsEstimated: true,
      newTokenCountIsEstimated: false,
    },
  });
  const html = render(s);
  expect(html).toContain("Agent 提供的 token 数");
  expect(html).toContain("1200（估算） → 800");
  expect(html).not.toContain("节省");
});
it.each([
  null,
  [],
  { source: "other", contextCompression: { phase: "done" } },
  { source: "slash_command", contextCompression: null },
  { source: "slash_command", contextCompression: [] },
  { source: "slash_command", contextCompression: { phase: "future-phase" } },
  { source: "slash_command", contextCompression: { phase: true } },
  { source: "slash_command", contextCompression: { phase: ["done"] } },
  {
    source: "slash_command",
    contextCompression: {
      phase: "done",
      originalTokenCount: Number.MAX_SAFE_INTEGER + 1,
      newTokenCount: 10,
    },
  },
  {
    source: "slash_command",
    contextCompression: {
      phase: "done",
      originalTokenCount: -1,
      newTokenCount: 10,
    },
  },
  {
    source: "slash_command",
    contextCompression: {
      phase: "done",
      originalTokenCount: "bad-count",
      newTokenCount: 10,
    },
  },
  {
    source: "slash_command",
    contextCompression: {
      phase: "done",
      originalTokenCount: 10,
      newTokenCount: 2,
      originalTokenCountIsEstimated: "bad-flag",
    },
  },
])(
  "leaves unsupported or malformed metadata in the original details: %j",
  (meta) => {
    const s = state();
    receive(
      s,
      meta,
      true,
      "Context compressed. No compression needed. Body unchanged.",
    );
    const before = structuredClone(s);
    const html = render(s);
    expect(html).not.toContain(prefix);
    expect(html).toContain(
      "Context compressed. No compression needed. Body unchanged.",
    );
    expect(s).toEqual(before);
    const item = s.items.find((entry) => entry.kind === "agent")!;
    expect(item.reportedDetails?.["/update/_meta"]).toEqual(meta);
  },
);
it("uses only the retained last metadata value, without creating a history or carrying progress into another frame", () => {
  const s = state();
  receive(s, {
    source: "slash_command",
    contextCompression: { phase: "progress" },
  });
  expect(render(s)).toContain(prefix);
  receive(
    s,
    { source: "slash_command", contextCompression: { phase: "future-phase" } },
    true,
    " Next original body",
  );
  expect(render(s)).not.toContain(prefix);
  expect(render(s)).toContain("Next original body");
});
it("cannot settle independent typed activity or an unknown request, alter queues, or dispatch work", () => {
  const s = state();
  s.connectionId = "connection";
  s.compactionActivity = {
    connectionId: "connection",
    sessionId: "native",
    compactionIds: ["independent"],
    uncertain: true,
  };
  s.connectionOutcomeUnknown = true;
  s.uncertainPrompt = [{ type: "text", text: "Original request" }];
  s.queuePaused = "uncertain";
  receive(s, {
    source: "slash_command",
    contextCompression: { phase: "done" },
  });
  const before = structuredClone(s);
  const callsBefore = vi.mocked(invoke).mock.calls.length;
  expect(render(s)).toContain(prefix);
  expect(vi.mocked(invoke).mock.calls).toHaveLength(callsBefore);
  expect(s).toEqual(before);
  expect(hasActiveCompaction(s)).toBe(true);
});
