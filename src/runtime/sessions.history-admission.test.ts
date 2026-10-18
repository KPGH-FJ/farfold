import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { historyReads } from "./session_history_admission";

const opened: string[] = [];
afterEach(async () => {
  for (const key of opened.splice(0)) await threads.close(key);
  h.invoke.mockReset();
  expect(historyReads.getSnapshot()).toEqual([]);
});

it.each([false, true])(
  "keeps the shared open, original mixed replay order, and raw control collisions (response first=%s)",
  async (responseFirst) => {
    type Port = { onmessage: (value: unknown) => void };
    let raw!: Port,
      progress!: Port,
      token!: string,
      finish!: (value: unknown) => void;
    const native = `history-progress-${responseFirst}`;
    const input = {
      agentId: "controlled",
      cwd: "/work",
      nativeSessionId: native,
    };
    h.invoke.mockImplementation((command, args) => {
      if (command !== "session_open") return Promise.resolve([]);
      raw = args.channel;
      progress = args.admissionChannel;
      token = args.openToken;
      return new Promise((resolve) => (finish = resolve));
    });
    const a = new AbortController(),
      b = new AbortController();
    const first = threads.open({ ...input, inquirySignal: a.signal });
    const second = threads.open({ ...input, inquirySignal: b.signal });
    expect(second).toBe(first);
    expect(raw).not.toBe(progress);
    progress.onmessage({
      kind: "session_history_admission",
      openToken: token,
      phase: "waiting",
    });
    a.abort();
    await Promise.resolve();
    expect(
      h.invoke.mock.calls.filter(([name]) => name === "session_open"),
    ).toHaveLength(1);
    expect(
      h.invoke.mock.calls.some(
        ([name]) => name === "session_open_cancel_waiting",
      ),
    ).toBe(false);
    const unknown: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      raw.onmessage({
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: `user-${i}` },
        },
      });
      raw.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `agent-${i}` },
        },
      });
      raw.onmessage({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tool-${i}`,
          title: `tool-${i}`,
          status: "completed",
        },
      });
      const value = {
        sessionUpdate: "future_history_value",
        position: i,
        exact: { nested: [null, "原值🙂", i] },
      };
      unknown.push(value);
      // Even a full matching control-shaped Agent envelope stays on the raw
      // route. It cannot report grant or disappear into the progress decoder.
      raw.onmessage({
        kind: "session_history_admission",
        openToken: token,
        phase: "starting",
        update: value,
      });
    }
    expect(historyReads.getSnapshot()[0].phase).toBe("waiting");
    const result = { cwd: "/work", nativeSessionId: native, resumed: true };
    if (responseFirst) {
      finish(result);
      await Promise.resolve();
    }
    progress.onmessage({
      kind: "session_history_admission",
      openToken: token,
      phase: "starting",
    });
    raw.onmessage({ kind: "session_history_complete", openToken: token });
    raw.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "live-following" },
      },
    });
    if (!responseFirst) finish(result);
    const state = await first;
    opened.push(state.key);
    expect(await second).toBe(state);
    expect(state.items.slice(0, 32).map((item) => item.kind)).toEqual(
      Array.from({ length: 8 }, () => ["user", "agent", "tool", "raw"]).flat(),
    );
    for (let i = 0; i < 8; i++) {
      expect(state.items[4 * i]).toMatchObject({
        kind: "user",
        text: `user-${i}`,
        time: 0,
      });
      expect(state.items[4 * i + 1]).toMatchObject({
        kind: "agent",
        text: `agent-${i}`,
        time: 0,
      });
      expect(state.items[4 * i + 2]).toMatchObject({
        kind: "tool",
        call: { toolCallId: `tool-${i}` },
      });
      const retained = state.items[4 * i + 3];
      expect(retained.kind === "raw" && retained.update).toBe(unknown[i]);
    }
    expect(state.items.at(-1)).toMatchObject({
      kind: "agent",
      text: "live-following",
    });
    expect(historyReads.getSnapshot()).toEqual([]);
    // A finished progress port no longer retains the opening interests.
    b.abort();
    progress.onmessage({
      kind: "session_history_admission",
      openToken: token,
      phase: "waiting",
    });
    await Promise.resolve();
    expect(
      h.invoke.mock.calls.some(([name]) =>
        [
          "session_open_cancel_waiting",
          "session_cancel",
          "session_prompt",
        ].includes(name),
      ),
    ).toBe(false);
  },
);
