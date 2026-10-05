import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHistoryPreview,
  commitHistoryPreview,
  discoverHistory,
  hasPreviewContent,
  historyContinuation,
  previewHistory,
  type DiscoveredConversation,
} from "./history_import";
import { IMPORT_STRINGS } from "./import_strings";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
}));
const row: DiscoveredConversation = {
  nativeSessionId: "native",
  cwd: "/notes",
  title: "Notes",
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
beforeEach(() => {
  invoke.mockReset();
});
afterEach(() => vi.useRealTimers());
describe("existing conversation import", () => {
  it.each([false, true])(
    "uses normalized model declarations while keeping raw notifications (empty=%s)",
    async (empty) => {
      const options = empty
        ? []
        : [
            {
              id: "__farfold_legacy_model",
              name: "模型",
              category: "model",
              type: "select",
              currentValue: "b",
              options: [{ value: "b", name: "Beta" }],
            },
          ];
      invoke.mockImplementation(async (_command, args) => {
        args.channel.onmessage({
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [
              {
                id: "effort",
                type: "select",
                currentValue: "low",
                options: [],
              },
            ],
          },
        });
        args.channel.onmessage({ kind: "configOptions", options });
        args.channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Original body" },
          },
        });
        args.channel.onmessage({
          kind: "history_preview_complete",
          previewToken: "owned",
        });
        return {
          cwd: "/notes",
          nativeSessionId: "native",
          previewToken: "owned",
          connectionId: "exact-connection",
          configOptions: [
            { id: "stale", type: "select", currentValue: "old", options: [] },
          ],
        };
      });
      const preview = await previewHistory("fixture", row);
      expect(preview.state.connectionId).toBe("exact-connection");
      expect(preview.state.configOptions.map((option) => option.id)).toEqual(
        empty ? [] : ["__farfold_legacy_model"],
      );
      expect(hasPreviewContent(preview)).toBe(true);
      expect(
        preview.state.items.some(
          (item) =>
            item.kind === "raw" &&
            (item.update as { sessionUpdate?: string }).sessionUpdate ===
              "config_option_update",
        ),
      ).toBe(true);
    },
  );
  it.each([
    ["ready", false, IMPORT_STRINGS.originalVerified],
    ["ready", true, IMPORT_STRINGS.permissionRequired],
    ["confirmation_required", false, IMPORT_STRINGS.confirmOriginal],
    ["blocked", false, IMPORT_STRINGS.readOnlyTitle],
    ["record_failed", false, IMPORT_STRINGS.readOnlyTitle],
  ] as const)(
    "keeps readable history separate from %s continuation conditions (permission=%s)",
    async (status, permission, title) => {
      const check = {
        status,
        issues:
          status === "ready"
            ? []
            : [
                {
                  category: "model",
                  reason: "unrecorded",
                  expected: null,
                  current: "returned-model",
                },
              ],
        current: { model: "returned-model" },
      };
      invoke.mockImplementation(async (command, args) => {
        if (command === "session_import_preview") {
          args.channel.onmessage({
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Historical body" },
            },
          });
          args.channel.onmessage({
            kind: "history_preview_complete",
            previewToken: "owned",
          });
          return {
            cwd: "/canonical",
            nativeSessionId: row.nativeSessionId,
            previewToken: "owned",
            configCheck: check,
            configOptions: [
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: "returned-model",
                options: [{ value: "returned-model", name: "Returned model" }],
              },
            ],
            permissionConfigId: permission ? "permission" : undefined,
            service: { id: "saved-source", model: "saved-model" },
            serviceContext: "saved-revision",
          };
        }
        return { id: "added" };
      });
      const preview = await previewHistory("fixture", row);
      expect(hasPreviewContent(preview)).toBe(true);
      expect(historyContinuation(preview).title).toBe(title);
      expect(preview.state).toMatchObject({
        identity: "established",
        resumed: true,
        configCheck: check,
        service: { id: "saved-source", model: "saved-model" },
      });
      expect(preview.state.modelDrift).toBe(status !== "ready");
      if (permission) expect(preview.state.permissionState).toBe("required");
      await commitHistoryPreview(preview, row.title);
      expect(invoke.mock.calls.map(([command]) => command)).toEqual([
        "session_import_preview",
        "session_import_commit",
      ]);
    },
  );

  it("does not label returned current options as a verified original selection without an explicit check", async () => {
    invoke.mockImplementationOnce(async (_command, args) => {
      args.channel.onmessage({
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Readable" },
        },
      });
      args.channel.onmessage({
        kind: "history_preview_complete",
        previewToken: "owned",
      });
      return {
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        previewToken: "owned",
        configOptions: [],
      };
    });
    const preview = await previewHistory("fixture", row);
    expect(historyContinuation(preview).title).toBe(
      IMPORT_STRINGS.continuationUnknown,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    { type: "resource_link", name: "notes.md", uri: "file:///notes.md" },
  ])(
    "admits complete attachment-only history with a visible message: $type",
    async (content) => {
      invoke.mockImplementation(async (command, args) => {
        if (command === "session_import_preview") {
          args.channel.onmessage({
            update: { sessionUpdate: "user_message_chunk", content },
          });
          args.channel.onmessage({
            kind: "history_preview_complete",
            previewToken: "owned",
          });
          return {
            cwd: row.cwd,
            nativeSessionId: row.nativeSessionId,
            previewToken: "owned",
          };
        }
        return { id: "local" };
      });
      const preview = await previewHistory("example", row);
      expect(hasPreviewContent(preview)).toBe(true);
      await commitHistoryPreview(preview, row.title);
      expect(invoke).toHaveBeenLastCalledWith(
        "session_import_commit",
        expect.objectContaining({ previewToken: "owned" }),
      );
    },
  );
  it("keeps the Agent default range unspecified and unsupported distinct", async () => {
    const page = { status: "unsupported", sessions: [], nextCursor: null };
    invoke.mockResolvedValue(page);
    expect(await discoverHistory("example", "page-2")).toEqual(page);
    expect(invoke).toHaveBeenCalledWith("session_discover", {
      agentId: "example",
      cursor: "page-2",
    });
  });
  it("uses an explicit lookup location for both the connection and the official list filter", async () => {
    invoke.mockResolvedValue({
      status: "supported",
      sessions: [row],
      nextCursor: null,
    });
    await discoverHistory("example", "page-2", "/notes");
    expect(invoke).toHaveBeenCalledWith("session_discover", {
      agentId: "example",
      cursor: "page-2",
      connectionCwd: "/notes",
      cwd: "/notes",
    });
  });
  it("projects actual load messages, and uses the returned location and ownership token", async () => {
    invoke.mockImplementation(async (command, args) => {
      if (command === "session_import_preview") {
        args.channel.onmessage({
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Original question" },
          },
        });
        args.channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Original answer" },
          },
        });
        args.channel.onmessage({
          kind: "history_preview_complete",
          previewToken: "owned",
        });
        return {
          cwd: "/canonical/notes",
          nativeSessionId: "native",
          previewToken: "owned",
        };
      }
      return { id: "local" };
    });
    const preview = await previewHistory("example", row);
    expect(hasPreviewContent(preview)).toBe(true);
    expect(
      preview.state.items
        .filter((item) => item.kind === "user" || item.kind === "agent")
        .map((item) => item.text),
    ).toEqual(["Original question", "Original answer"]);
    await commitHistoryPreview(preview, "Notes");
    expect(invoke).toHaveBeenLastCalledWith("session_import_commit", {
      agentId: "example",
      cwd: "/canonical/notes",
      sessionId: "native",
      previewToken: "owned",
      title: "Notes",
    });
    await closeHistoryPreview(preview);
    expect(invoke).toHaveBeenLastCalledWith("session_import_close", {
      agentId: "example",
      cwd: "/canonical/notes",
      sessionId: "native",
      previewToken: "owned",
    });
  });
  it("waits for replay on the same channel when invoke returns first", async () => {
    let deliver!: (event: unknown) => void;
    invoke.mockImplementation(async (command, args) => {
      if (command === "session_import_preview") {
        deliver = args.channel.onmessage;
        return {
          cwd: "/canonical/notes",
          nativeSessionId: "native",
          previewToken: "owned",
        };
      }
      return { id: "local" };
    });
    let settled = false;
    const pending = previewHistory("example", row).then((preview) => {
      settled = true;
      return preview;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    deliver({
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Original question" },
      },
    });
    deliver({ kind: "history_preview_complete", previewToken: "other" });
    await Promise.resolve();
    expect(settled).toBe(false);
    deliver({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Original answer" },
      },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    deliver({ kind: "history_preview_complete", previewToken: "owned" });
    const preview = await pending;
    expect(hasPreviewContent(preview)).toBe(true);
    expect(
      preview.state.items
        .filter((item) => item.kind === "user" || item.kind === "agent")
        .map((item) => item.text),
    ).toEqual(["Original question", "Original answer"]);
    await commitHistoryPreview(preview, row.title);
    expect(invoke).toHaveBeenLastCalledWith("session_import_commit", {
      agentId: "example",
      cwd: "/canonical/notes",
      sessionId: "native",
      previewToken: "owned",
      title: "Notes",
    });
  });
  it("never registers an empty load and retains ownership so a failed close can be retried", async () => {
    invoke.mockImplementationOnce(async (_command, args) => {
      args.channel.onmessage({
        kind: "history_preview_complete",
        previewToken: "owned",
      });
      return {
        cwd: "/notes",
        nativeSessionId: "native",
        previewToken: "owned",
      };
    });
    const preview = await previewHistory("example", row);
    expect(hasPreviewContent(preview)).toBe(false);
    await expect(commitHistoryPreview(preview, "Notes")).rejects.toThrow(
      IMPORT_STRINGS.noContent,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockRejectedValueOnce(new Error("close failed"));
    await expect(closeHistoryPreview(preview)).rejects.toThrow("close failed");
    invoke.mockResolvedValueOnce(undefined);
    await closeHistoryPreview(preview);
    expect(invoke).toHaveBeenLastCalledWith("session_import_close", {
      agentId: "example",
      cwd: "/notes",
      sessionId: "native",
      previewToken: "owned",
    });
  });
  it("propagates a failed lookup instead of substituting local metadata", async () => {
    invoke.mockRejectedValue(new Error("Agent unavailable"));
    await expect(discoverHistory("example")).rejects.toThrow(
      "Agent unavailable",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects failed loads without waiting for a success marker or admitting partial replay", async () => {
    invoke.mockImplementationOnce(async (_command, args) => {
      args.channel.onmessage({
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Incomplete replay" },
        },
      });
      throw new Error("load failed");
    });
    await expect(previewHistory("example", row)).rejects.toThrow("load failed");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("retains ownership on a missing completion marker and never admits or later mutates partial replay", async () => {
    vi.useFakeTimers();
    let deliver!: (event: unknown) => void;
    invoke.mockImplementationOnce(async (_command, args) => {
      deliver = args.channel.onmessage;
      deliver({
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "Incomplete replay" },
        },
      });
      return {
        cwd: "/canonical/notes",
        nativeSessionId: "native",
        previewToken: "owned",
      };
    });
    const pending = previewHistory("example", row);
    await vi.runAllTimersAsync();
    const preview = await pending;
    expect(preview.replayComplete).toBe(false);
    expect(hasPreviewContent(preview)).toBe(false);
    await expect(commitHistoryPreview(preview, "Notes")).rejects.toThrow(
      IMPORT_STRINGS.loadFailed,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    const before = structuredClone(preview.state.items);
    deliver({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Late partial text" },
      },
    });
    deliver({ kind: "history_preview_complete", previewToken: "owned" });
    expect(preview.state.items).toEqual(before);
    expect(preview.replayComplete).toBe(false);
    invoke.mockRejectedValueOnce(new Error("close failed"));
    await expect(closeHistoryPreview(preview)).rejects.toThrow("close failed");
    invoke.mockResolvedValueOnce(undefined);
    await closeHistoryPreview(preview);
    expect(invoke).toHaveBeenLastCalledWith("session_import_close", {
      agentId: "example",
      cwd: "/canonical/notes",
      sessionId: "native",
      previewToken: "owned",
    });
  });
});
