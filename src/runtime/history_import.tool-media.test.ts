import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));
import {
  previewHistory,
  readHistoryPreview,
  closeHistoryPreview,
  commitHistoryPreview,
  type HistoryPreview,
  type HistoryPreviewPurpose,
} from "./history_import";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";
import { IMPORT_STRINGS as S } from "./import_strings";

const row = {
  nativeSessionId: "owned",
  cwd: "/owned",
  title: null,
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
type Wire = { openToken: string; channel: { onmessage(event: unknown): void } };
const result = (purpose: HistoryPreviewPurpose) => ({
  purpose,
  nativeSessionId: row.nativeSessionId,
  cwd: row.cwd,
  connectionId: "private-connection",
  previewToken: "exact-token",
  configOptions: [],
});
const image = {
  type: "image",
  mimeType: "image/png",
  data: PNG_IMAGE_TEST_DATA,
};
const source = () => ({
  sessionId: "owned",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "page",
    title: "Read page",
    status: "completed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "Original display text" },
      },
    ],
    rawOutput: { type: "success", content: [image] },
  },
});
const media = () => ({
  kind: "toolMedia",
  sessionId: "owned",
  connectionId: "private-connection",
  toolCallId: "page",
  content: [image],
});
const header = (wire: Wire) => ({
  kind: "sessionOpening",
  openToken: wire.openToken,
  cwd: "/owned",
  sessionId: "owned",
  connectionId: "private-connection",
});
const marker = (wire: Wire) => ({
  kind: "history_preview_complete",
  openToken: wire.openToken,
  previewToken: "exact-token",
});
const body = {
  sessionId: "owned",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Existing history" },
  },
};
const load = (
  purpose: HistoryPreviewPurpose,
  interest?: { inquirySignal?: AbortSignal; inquiryCurrent?: () => boolean },
) =>
  purpose === "importPreview"
    ? previewHistory("agent", row, interest)
    : readHistoryPreview("agent", row, interest);
const attachments = (preview: HistoryPreview) =>
  preview.state.items.flatMap((item) =>
    item.kind === "tool"
      ? item.call.content.filter((c) => c.type === "attachment")
      : [],
  );
afterEach(() => {
  h.invoke.mockReset();
  vi.restoreAllMocks();
});

it.each(["importPreview", "searchReadOnly"] as const)(
  "keeps typed tool media in %s without acquiring live controls",
  async (purpose) => {
    h.invoke.mockImplementation(async (command, wire: Wire) => {
      expect(command).toBe(
        purpose === "importPreview"
          ? "session_import_preview"
          : "session_read_preview",
      );
      for (const event of [header(wire), body, source(), media(), marker(wire)])
        wire.channel.onmessage(event);
      return result(purpose);
    });
    const preview = await load(purpose);
    expect(preview.replayComplete).toBe(true);
    expect(attachments(preview)).toHaveLength(1);
    expect(attachments(preview)[0].attachment.data).toBe(PNG_IMAGE_TEST_DATA);
    expect(preview.state.running).toBe(false);
    expect(preview.state.pendingPermissions).toEqual([]);
    expect(preview.state.pendingElicitations).toEqual([]);
    expect(preview.state.queued).toEqual([]);
    expect(
      preview.state.items.find((item) => item.kind === "tool"),
    ).toMatchObject({
      call: {
        rawOutput: source().update.rawOutput,
        content: [
          { type: "text", text: "Original display text" },
          { type: "attachment" },
        ],
      },
    });
    if (purpose === "searchReadOnly")
      await expect(commitHistoryPreview(preview, null)).rejects.toThrow(
        S.loadFailed,
      );
    expect(h.invoke).toHaveBeenCalledTimes(1);
  },
);

it.each([true, false])(
  "uses the same private owner when the result arrives first=%s",
  async (resultFirst) => {
    let wire!: Wire;
    let release!: (v: ReturnType<typeof result>) => void;
    h.invoke.mockImplementation((_command, args: Wire) => {
      wire = args;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = load("searchReadOnly");
    if (resultFirst) {
      release(result("searchReadOnly"));
      await Promise.resolve();
    }
    for (const event of [header(wire), body, source(), media(), marker(wire)])
      wire.channel.onmessage(event);
    if (!resultFirst) release(result("searchReadOnly"));
    const preview = await pending;
    expect(preview.replayComplete).toBe(true);
    expect(attachments(preview)).toHaveLength(1);
  },
);

it.each([
  "missing header",
  "foreign header",
  "foreign connection",
  "wrong tool",
  "intervening header",
  "after marker",
  "forged source kind",
])("cannot use %s as media authority", async (change) => {
  h.invoke.mockImplementation(async (_command, wire: Wire) => {
    if (change !== "missing header")
      wire.channel.onmessage({
        ...header(wire),
        ...(change === "foreign header" ? { openToken: "different-open" } : {}),
      });
    wire.channel.onmessage(body);
    const original = source();
    wire.channel.onmessage(
      change === "forged source kind"
        ? { ...original, kind: "toolMedia" }
        : original,
    );
    if (change === "intervening header") wire.channel.onmessage(header(wire));
    if (change === "after marker") wire.channel.onmessage(marker(wire));
    wire.channel.onmessage({
      ...media(),
      ...(change === "foreign connection"
        ? { connectionId: "live-connection" }
        : {}),
      ...(change === "wrong tool" ? { toolCallId: "other" } : {}),
    });
    wire.channel.onmessage(marker(wire));
    return result("importPreview");
  });
  const preview = await load("importPreview");
  expect(preview.replayComplete).toBe(true);
  expect(attachments(preview)).toEqual([]);
  expect(
    preview.state.items.find((item) => item.kind === "tool"),
  ).toMatchObject({ call: { rawOutput: source().update.rawOutput } });
});

it.each(["cwd", "nativeSessionId", "connectionId", "purpose"])(
  "rejects a result whose %s contradicts the media owner but retains exact cleanup",
  async (key) => {
    const reply = {
      ...result("importPreview"),
      [key]: key === "purpose" ? "searchReadOnly" : "other",
    };
    h.invoke.mockImplementation(async (command, wire: Wire) => {
      if (command === "session_import_close") return;
      for (const event of [header(wire), body, source(), media(), marker(wire)])
        wire.channel.onmessage(event);
      return reply;
    });
    const preview = await load("importPreview");
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
    await closeHistoryPreview(preview);
    expect(h.invoke).toHaveBeenLastCalledWith("session_import_close", {
      agentId: "agent",
      cwd: reply.cwd,
      sessionId: reply.nativeSessionId,
      previewToken: reply.previewToken,
    });
  },
);

it("discards a canceled media prefix and cannot revive it from late channel traffic", async () => {
  const abort = new AbortController();
  let delivered!: Wire;
  h.invoke.mockImplementation(async (_command, wire: Wire) => {
    delivered = wire;
    for (const event of [header(wire), body, source()])
      wire.channel.onmessage(event);
    abort.abort();
    wire.channel.onmessage(media());
    wire.channel.onmessage(marker(wire));
    return result("searchReadOnly");
  });
  const preview = await load("searchReadOnly", { inquirySignal: abort.signal });
  expect(preview.replayComplete).toBe(false);
  expect(preview.state.items).toEqual([]);
  for (const event of [header(delivered), source(), media(), marker(delivered)])
    delivered.channel.onmessage(event);
  expect(preview.state.items).toEqual([]);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "does not publish media from conflicting headers (result first=%s)",
  async (resultFirst) => {
    let wire!: Wire;
    let release!: (v: ReturnType<typeof result>) => void;
    h.invoke.mockImplementation((_command, args: Wire) => {
      wire = args;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = load("searchReadOnly");
    if (resultFirst) {
      release(result("searchReadOnly"));
      await Promise.resolve();
    }
    for (const event of [
      header(wire),
      body,
      source(),
      media(),
      { ...header(wire), connectionId: "replacement" },
      marker(wire),
    ])
      wire.channel.onmessage(event);
    if (!resultFirst) release(result("searchReadOnly"));
    const preview = await pending;
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
  },
);

it("retains a rejected media envelope and its original result while keeping ordinary preview usable", async () => {
  const rejected = {
    ...media(),
    content: [{ ...image, mimeType: "image/svg+xml" }],
  };
  h.invoke.mockImplementation(async (_command, wire: Wire) => {
    for (const event of [header(wire), body, source(), rejected, marker(wire)])
      wire.channel.onmessage(event);
    return result("searchReadOnly");
  });
  const preview = await load("searchReadOnly");
  expect(preview.replayComplete).toBe(true);
  expect(attachments(preview)).toEqual([]);
  expect(preview.state.items).toContainEqual(
    expect.objectContaining({ kind: "raw", update: rejected }),
  );
  expect(
    preview.state.items.find((item) => item.kind === "tool"),
  ).toMatchObject({ call: { rawOutput: source().update.rawOutput } });
});

it("does not attach from forged presentation data or late media after the preview is returned", async () => {
  let wire!: Wire;
  const original = { ...source(), presentation: media() };
  h.invoke.mockImplementation(async (_command, args: Wire) => {
    wire = args;
    for (const event of [header(wire), body, original, marker(wire)])
      wire.channel.onmessage(event);
    return result("importPreview");
  });
  const preview = await load("importPreview");
  expect(attachments(preview)).toEqual([]);
  wire.channel.onmessage(media());
  expect(attachments(preview)).toEqual([]);
  const item = preview.state.items.find((item) => item.kind === "tool");
  expect(
    item?.kind === "tool" && item.call.reportedDetails?.["/presentation"],
  ).toEqual(media());
});

it("does not let a late opening header change an already sealed preview prefix", async () => {
  h.invoke.mockImplementation(async (_command, wire: Wire) => {
    for (const event of [
      header(wire),
      body,
      source(),
      media(),
      marker(wire),
      { ...header(wire), connectionId: "late-other" },
    ])
      wire.channel.onmessage(event);
    return result("searchReadOnly");
  });
  const preview = await load("searchReadOnly");
  expect(preview.replayComplete).toBe(true);
  expect(attachments(preview)).toHaveLength(1);
  expect(preview.state.connectionId).toBe("private-connection");
});
