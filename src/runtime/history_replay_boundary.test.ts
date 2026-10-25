import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { emitOpeningHeader } from "./session_open_test_fixture";
import {
  commitHistoryPreview,
  hasPreviewContent,
  previewHistory,
  type DiscoveredConversation,
} from "./history_import";
import { IMPORT_STRINGS } from "./import_strings";

afterEach(() => {
  vi.useRealTimers();
  h.invoke.mockReset();
  vi.restoreAllMocks();
});

const message = (text: string) => ({
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: text,
    content: { type: "text", text },
  },
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "does not admit text after an empty prefix (duplicate=%s, response first=%s)",
  async (duplicate, responseFirst) => {
    const native = `empty-prefix-${duplicate}-${responseFirst}`;
    const key = `boundary-fixture:/boundary:${native}`;
    const prior = threads.markOpenFailed(
      key,
      "boundary-fixture",
      "/boundary",
      native,
      "retry",
    );
    prior.items.push({
      kind: "agent",
      id: "prior",
      text: "Keep prior history",
      streaming: false,
      time: 0,
    });
    let deliver!: (event: unknown) => void;
    let replay!: () => void;
    h.invoke.mockImplementation(async (command, args) => {
      if (command !== "session_open") return [];
      deliver = args.channel.onmessage;
      emitOpeningHeader(args, {
        cwd: "/boundary",
        nativeSessionId: native,
        connectionId: "boundary-owned",
      });
      const marker = {
        kind: "session_history_complete",
        openToken: args.openToken,
      };
      replay = () => {
        deliver(marker);
        if (duplicate) deliver(marker);
      };
      if (!responseFirst) replay();
      return {
        cwd: "/boundary",
        nativeSessionId: native,
        connectionId: "boundary-owned",
        resumed: true,
      };
    });
    const opening = threads.open({
      agentId: "boundary-fixture",
      cwd: "/boundary",
      nativeSessionId: native,
    });
    if (responseFirst) {
      await Promise.resolve();
      expect(prior.reconnecting).toBe(true);
      replay();
    }
    await expect(opening).rejects.toThrow();
    expect(threads.thread(key)).toBe(prior);
    expect(prior.historyUnavailable?.reason).toBe("empty");
    expect(prior.items).toEqual([
      expect.objectContaining({ text: "Keep prior history" }),
    ]);
    const late = message("Even later text cannot repair that failed load");
    deliver(late);
    expect(prior.items).toHaveLength(2);
    expect(prior.items[0]).toMatchObject({ text: "Keep prior history" });
    expect(prior.items[1]).toMatchObject({ kind: "raw", update: late });
  },
);

it("preserves messages and tool activity after the history prefix as live updates", async () => {
  vi.spyOn(Date, "now").mockReturnValue(200_000);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "agent_work_get") return { cwd: args.cwd, enabled: {} };
    if (command !== "session_open") return [];
    const deliver = args.channel.onmessage;
    emitOpeningHeader(args, {
      cwd: "/boundary",
      nativeSessionId: "live-prefix",
      connectionId: "boundary-live",
    });
    deliver(message("Historical body"));
    deliver({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    deliver({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "live-tool",
        title: "Live tool",
        status: "in_progress",
      },
    });
    deliver({ kind: "toolActivity", toolCallIds: ["live-tool"] });
    deliver(message("Live body after the prefix"));
    return {
      cwd: "/boundary",
      nativeSessionId: "live-prefix",
      connectionId: "boundary-live",
      resumed: true,
    };
  });
  const state = await threads.open({
    agentId: "boundary-fixture",
    cwd: "/boundary",
    nativeSessionId: "live-prefix",
  });
  const historical = state.items.find(
    (item) => item.kind === "agent" && item.text === "Historical body",
  );
  const live = state.items.find(
    (item) =>
      item.kind === "agent" && item.text === "Live body after the prefix",
  );
  expect(historical).toMatchObject({ time: 0, streaming: false });
  expect(live).toMatchObject({ time: 200_000, streaming: true });
  const tool = state.items.find((item) => item.kind === "tool");
  expect(tool?.kind === "tool" && tool.call.startedAt).toBe(200_000);
  expect(state.activeToolCallIds).toEqual(["live-tool"]);
});

it("keeps a loss observed after the prefix from admitting a disconnected recovery", async () => {
  const native = "lost-after-prefix";
  const prior = threads.markOpenFailed(
    `boundary-fixture:/boundary:${native}`,
    "boundary-fixture",
    "/boundary",
    native,
    "retry",
  );
  h.invoke.mockImplementation(async (command, args) => {
    if (command !== "session_open") return [];
    emitOpeningHeader(args, {
      cwd: "/boundary",
      nativeSessionId: native,
      connectionId: "boundary-owned",
    });
    args.channel.onmessage(message("Readable history"));
    args.channel.onmessage({
      kind: "session_history_complete",
      openToken: args.openToken,
    });
    args.channel.onmessage({ kind: "connectionLost" });
    return {
      cwd: "/boundary",
      nativeSessionId: native,
      connectionId: "boundary-owned",
      resumed: true,
    };
  });
  await expect(
    threads.open({
      agentId: "boundary-fixture",
      cwd: "/boundary",
      nativeSessionId: native,
    }),
  ).rejects.toThrow();
  expect(threads.thread(prior.key)).toBe(prior);
  expect(prior.connectionLost).toBe(true);
});

const row: DiscoveredConversation = {
  nativeSessionId: "preview-prefix",
  cwd: "/boundary",
  title: null,
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};

it.each([false, true])(
  "does not project an unconfirmed preview prefix (wrong token=%s)",
  async (wrongToken) => {
    vi.useFakeTimers();
    h.invoke.mockImplementation(async (_command, args) => {
      args.channel.onmessage(message("Unconfirmed preview fragment"));
      if (wrongToken)
        args.channel.onmessage({
          kind: "history_preview_complete",
          openToken: args.openToken,
          previewToken: "another-preview",
        });
      return {
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        purpose: "importPreview",
        previewToken: "owned-prefix",
      };
    });
    const pending = previewHistory("boundary-fixture", row);
    await vi.runAllTimersAsync();
    const preview = await pending;
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
    expect(hasPreviewContent(preview)).toBe(false);
  },
);

it.each([false, true])(
  "keeps a read-only preview limited to its acknowledged prefix (readable=%s)",
  async (readable) => {
    h.invoke.mockImplementation(async (command, args) => {
      if (command !== "session_import_preview") return { id: "added" };
      const deliver = args.channel.onmessage;
      if (readable) deliver(message("Historical preview body"));
      const marker = {
        kind: "history_preview_complete",
        openToken: args.openToken,
        previewToken: "owned-prefix",
      };
      deliver(marker);
      deliver(message("Late body is not in that snapshot"));
      deliver(marker);
      return {
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        purpose: "importPreview",
        previewToken: "owned-prefix",
      };
    });
    const preview = await previewHistory("boundary-fixture", row);
    expect(preview.replayComplete).toBe(true);
    expect(hasPreviewContent(preview)).toBe(readable);
    expect(
      preview.state.items.flatMap((item) =>
        item.kind === "agent" ? [item.text] : [],
      ),
    ).toEqual(readable ? ["Historical preview body"] : []);
    if (!readable) {
      await expect(commitHistoryPreview(preview, null)).rejects.toThrow(
        IMPORT_STRINGS.noContent,
      );
      expect(h.invoke).toHaveBeenCalledTimes(1);
    }
  },
);
