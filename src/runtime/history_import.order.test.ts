import { expect, it, vi } from "vitest";
import { previewHistory } from "./history_import";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
}));

it("keeps the acknowledged official replay prefix's media and text order", async () => {
  invoke.mockImplementation(async (command, args) => {
    expect(command).toBe("session_import_preview");
    for (const content of [
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "text", text: "Historical caption" },
      { type: "audio", mimeType: "audio/aac", data: "YXVkaW8=" },
    ])
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "official-history-message",
          content,
        },
      });
    args.channel.onmessage({
      kind: "history_preview_complete",
      openToken: args.openToken,
      previewToken: "owned-prefix",
    });
    return {
      cwd: "/owned",
      nativeSessionId: "original-id",
      connectionId: "original-connection",
      purpose: "importPreview",
      previewToken: "owned-prefix",
      configOptions: [],
    };
  });
  const preview = await previewHistory("chosen", {
    nativeSessionId: "original-id",
    cwd: "/owned",
    title: "Original",
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId: null,
    isOpen: false,
  });
  expect(preview.replayComplete).toBe(true);
  expect(preview.state.items).toHaveLength(1);
  expect(preview.state.items[0]).toMatchObject({
    kind: "agent",
    messageId: "official-history-message",
    text: "Historical caption",
    time: 0,
    streaming: false,
    attachments: [{ data: "aW1hZ2U=" }, { data: "YXVkaW8=" }],
    contentOrder: [
      { kind: "attachments", start: 0, end: 1 },
      { kind: "text", start: 0, end: 18 },
      { kind: "attachments", start: 1, end: 2 },
    ],
  });
  expect(preview.state.nativeSessionId).toBe("original-id");
  expect(invoke).toHaveBeenCalledTimes(1);
});
