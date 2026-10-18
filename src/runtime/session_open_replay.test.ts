import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { STRINGS } from "./strings";

afterEach(() => {
  vi.useRealTimers();
  h.invoke.mockReset();
});

const message = (id: string, text: string) => ({
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text },
  },
});

it.each([false, true])(
  "shares the exact opening promise and retains replay/live/unknown order (response first=%s)",
  async (responseFirst) => {
    const native = `extracted-replay-${responseFirst}`;
    let deliver!: (event: unknown) => void;
    let finish!: () => void;
    let marker!: unknown;
    h.invoke.mockImplementation((command, args) => {
      if (command !== "session_open") return Promise.resolve([]);
      deliver = args.channel.onmessage;
      marker = {
        kind: "session_history_complete",
        openToken: args.openToken,
      };
      return new Promise((resolve) => {
        finish = () =>
          resolve({ cwd: "/replay", nativeSessionId: native, resumed: true });
      });
    });
    const input = {
      agentId: "extracted-replay",
      cwd: "/replay",
      nativeSessionId: native,
    };
    threads.markOpenFailed(
      `${input.agentId}:${input.cwd}:${native}`,
      input.agentId,
      input.cwd,
      native,
      "retry",
    );
    const first = threads.open(input);
    const second = threads.open(input);
    expect(second).toBe(first);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const unknown = {
      sessionUpdate: "future_replay_control",
      value: { ordered: [null, "原值🙂", 7] },
    };
    if (responseFirst) {
      finish();
      await Promise.resolve();
    }
    deliver(message("old", "Historical body"));
    deliver({ update: unknown });
    deliver(marker);
    deliver(message("live", "Live following body"));
    deliver(marker);
    if (!responseFirst) finish();
    const state = await first;
    expect(await second).toBe(state);
    expect(
      state.items.flatMap((item) => (item.kind === "agent" ? [item.text] : [])),
    ).toEqual(["Historical body", "Live following body"]);
    const retained = state.items.find((item) => item.kind === "raw");
    expect(retained?.kind === "raw" && retained.update).toBe(unknown);
  },
);

it("keeps the 30 second marker deadline and rejects late replay after timeout", async () => {
  vi.useFakeTimers();
  let deliver!: (event: unknown) => void;
  let marker!: unknown;
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    deliver = args.channel.onmessage;
    marker = {
      kind: "session_history_complete",
      openToken: args.openToken,
    };
    deliver(message("unconfirmed", "Unconfirmed replay"));
    return { cwd: "/replay", nativeSessionId: "marker-timeout", resumed: true };
  });
  threads.markOpenFailed(
    "extracted-replay:/replay:marker-timeout",
    "extracted-replay",
    "/replay",
    "marker-timeout",
    "retry",
  );
  const first = threads.open({
    agentId: "extracted-replay",
    cwd: "/replay",
    nativeSessionId: "marker-timeout",
  });
  let settled = false;
  const rejected = first.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await vi.advanceTimersByTimeAsync(29_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await rejected).toMatchObject({
    message: STRINGS.repair.historyUnavailable,
  });
  const state = threads.thread("extracted-replay:/replay:marker-timeout");
  expect(state?.historyUnavailable?.reason).toBe("incomplete");
  expect(state?.items).toEqual([]);
  deliver(marker);
  deliver(message("late", "Cannot repair a failed replay"));
  expect(state?.items).toEqual([]);
});
