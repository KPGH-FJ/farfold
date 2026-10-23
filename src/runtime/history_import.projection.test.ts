import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import { previewHistory, commitHistoryPreview } from "./history_import";
import { HistoryReplayProjection } from "./history_replay_projection";
import * as projection from "./session_projection";
import { IMPORT_STRINGS as S } from "./import_strings";
import type { ThreadState } from "./session_types";

interface Wire {
  openToken: string;
  channel: { onmessage(event: unknown): void };
}
const row = {
  nativeSessionId: "known-preview",
  cwd: "/known-preview",
  title: null,
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
const result = {
  nativeSessionId: row.nativeSessionId,
  cwd: row.cwd,
  connectionId: "preview-owner",
  previewToken: "exact-preview",
  configOptions: [],
};
const message = (id: string) => ({
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: id,
    content: { type: "text", text: id },
  },
});
const marker = (wire: Wire, previewToken = result.previewToken) => ({
  kind: "history_preview_complete",
  openToken: wire.openToken,
  previewToken,
});

afterEach(() => {
  h.invoke.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("projects delivered preview events once into the same private view before the invoke result, without raw replay staging", async () => {
  const push = vi.spyOn(HistoryReplayProjection.prototype, "push");
  const take = vi.spyOn(HistoryReplayProjection.prototype, "take");
  const apply = vi.spyOn(projection, "applyUpdate");
  let wire!: Wire;
  let release!: (value: typeof result) => void;
  h.invoke.mockImplementation((command, args: Wire) => {
    expect(command).toBe("session_import_preview");
    wire = args;
    return new Promise<typeof result>((resolve) => {
      release = resolve;
    });
  });
  const pending = previewHistory("agent", row);
  let staged: ThreadState | undefined;
  let items: ThreadState["items"] | undefined;
  try {
    for (let index = 0; index < 128; index++) {
      wire.channel.onmessage(message(`owned-${index}`));
      staged = (push.mock.contexts.at(-1) as HistoryReplayProjection).state;
      expect(staged?.items).toHaveLength(index + 1);
      expect(staged?.nativeSessionId).toBe(row.nativeSessionId);
    }
    items = staged!.items;
    expect(apply).toHaveBeenCalledTimes(128);
    expect(push).toHaveBeenCalledTimes(128);
    expect(take).not.toHaveBeenCalled();
  } finally {
    wire.channel.onmessage(marker(wire));
    release(result);
  }
  const preview = await pending;
  expect(preview.replayComplete).toBe(true);
  expect(preview.state).toBe(staged);
  expect(preview.state.items).toBe(items);
  expect(apply).toHaveBeenCalledTimes(128);
  expect(preview.state.items[127]).toMatchObject({
    text: "owned-127",
    time: 0,
    streaming: false,
  });
  expect(push).toHaveBeenCalledTimes(128);
  expect(take).toHaveBeenCalledTimes(1);
  expect(take.mock.results[0].value).toBe(preview.state);
});

it.each([undefined, "another-open-request"])(
  "does not admit a marker without this exact request owner (%s)",
  async (openToken) => {
    vi.useFakeTimers();
    h.invoke.mockImplementation(async (_command, wire: Wire) => {
      wire.channel.onmessage(message("not acknowledged"));
      wire.channel.onmessage({
        kind: "history_preview_complete",
        ...(openToken === undefined ? {} : { openToken }),
        previewToken: result.previewToken,
      });
      return result;
    });
    const pending = previewHistory("agent", row);
    await vi.runAllTimersAsync();
    const preview = await pending;
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
    expect(preview.state.openError).toBe(S.loadFailed);
    await expect(commitHistoryPreview(preview, null)).rejects.toThrow(
      S.loadFailed,
    );
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it("consumes only this exact native opening header and keeps a same-shaped Agent update raw", async () => {
  const push = vi.spyOn(HistoryReplayProjection.prototype, "push");
  const update = { sessionUpdate: "future_opening", original: [null, false] };
  h.invoke.mockImplementation(async (_command, wire: Wire) => {
    const header = {
      kind: "sessionOpening",
      openToken: wire.openToken,
      sessionId: row.nativeSessionId,
      connectionId: result.connectionId,
      cwd: row.cwd,
    };
    wire.channel.onmessage(header);
    wire.channel.onmessage({ ...header, openToken: "foreign-request" });
    wire.channel.onmessage({ ...header, sessionId: "another-history" });
    wire.channel.onmessage({ ...header, connectionId: "" });
    expect(push).not.toHaveBeenCalled();
    wire.channel.onmessage({ ...header, update });
    wire.channel.onmessage(message("original body"));
    wire.channel.onmessage(marker(wire));
    return result;
  });
  const preview = await previewHistory("agent", row);
  expect(preview.replayComplete).toBe(true);
  expect(preview.state.items).toHaveLength(2);
  expect(preview.state.items[0]).toMatchObject({ kind: "raw", update });
  expect(preview.state.items[1]).toMatchObject({ text: "original body" });
  expect(push).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "requires the first exact request marker's cleanup token to match the result (response first=%s)",
  async (responseFirst) => {
    let wire!: Wire;
    h.invoke.mockImplementation(async (_command, args: Wire) => {
      wire = args;
      if (!responseFirst) {
        wire.channel.onmessage(message("prefix"));
        wire.channel.onmessage(marker(wire, "another-preview"));
      }
      return result;
    });
    const pending = previewHistory("agent", row);
    if (responseFirst) {
      await Promise.resolve();
      wire.channel.onmessage(message("prefix"));
      wire.channel.onmessage(marker(wire, "another-preview"));
    }
    // The same request's duplicate marker cannot replace the sealed owner or
    // expand its prefix to turn the earlier mismatch into success.
    wire.channel.onmessage(message("following is not acknowledged"));
    wire.channel.onmessage(marker(wire));
    const preview = await pending;
    expect(preview.previewToken).toBe(result.previewToken);
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
    expect(preview.state.openError).toBe(S.loadFailed);
    await expect(commitHistoryPreview(preview, null)).rejects.toThrow(
      S.loadFailed,
    );
  },
);

it("does not let post-marker updates mutate an existing tool or opaque prefix", async () => {
  const opaque = {
    kind: "history_preview_complete",
    openToken: "not a client control",
    update: { sessionUpdate: "future_owned", exact: [null, "中文🙂", false] },
  };
  h.invoke.mockImplementation(async (_command, wire: Wire) => {
    wire.channel.onmessage(message("readable prefix"));
    wire.channel.onmessage({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "prefix-tool",
        title: "Original tool",
        status: "in_progress",
      },
    });
    wire.channel.onmessage(opaque);
    wire.channel.onmessage(marker(wire));
    wire.channel.onmessage({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "prefix-tool",
        title: "Late mutation",
        status: "completed",
      },
    });
    wire.channel.onmessage({ kind: "configOptions", options: [] });
    wire.channel.onmessage(message("late body"));
    wire.channel.onmessage(marker(wire));
    return result;
  });
  const preview = await previewHistory("agent", row);
  expect(preview.replayComplete).toBe(true);
  expect(preview.state.items).toHaveLength(3);
  expect(preview.state.items[1]).toMatchObject({
    kind: "tool",
    call: { title: "Original tool", status: "in_progress", startedAt: 0 },
  });
  expect(preview.state.items[2]).toMatchObject({
    kind: "raw",
    update: opaque.update,
  });
  expect(JSON.stringify(preview.state.items)).not.toContain("Late mutation");
  expect(JSON.stringify(preview.state.items)).not.toContain("late body");
});

it.each([false, true])(
  "keeps an early explicit configuration after the result baseline without enabling a separate modes surface (empty=%s)",
  async (empty) => {
    h.invoke.mockImplementation(async (_command, wire: Wire) => {
      wire.channel.onmessage({
        kind: "configOptions",
        modern: false,
        options: empty
          ? []
          : [{ id: "early", type: "boolean", currentValue: true }],
      });
      wire.channel.onmessage({
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            { id: "raw-only", type: "boolean", currentValue: false },
          ],
        },
      });
      wire.channel.onmessage(message("original body"));
      wire.channel.onmessage(marker(wire));
      return {
        ...result,
        configOptions: [
          { id: "baseline", type: "boolean", currentValue: false },
        ],
      };
    });
    const preview = await previewHistory("agent", row);
    expect(preview.replayComplete).toBe(true);
    expect(preview.state.configOptions.map((option) => option.id)).toEqual(
      empty ? [] : ["early"],
    );
    expect(preview.state.modesSeparate).toBe(false);
    expect(preview.state.items.some((item) => item.kind === "raw")).toBe(true);
  },
);
