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
  commitHistoryPreview,
  closeHistoryPreview,
} from "./history_import";
import { IMPORT_STRINGS } from "./import_strings";

const row = {
  nativeSessionId: "history",
  cwd: "/owned-preview",
  title: null,
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
const result = {
  cwd: row.cwd,
  nativeSessionId: row.nativeSessionId,
  connectionId: "preview-connection",
  purpose: "importPreview",
  previewToken: "exact-preview",
};
const owner = {
  connectionId: "preview-connection",
  sessionId: "history",
  requestId: "approval",
};
const permission = {
  kind: "permissionRequest",
  requestId: "approval",
  owner,
  toolCall: { toolCallId: "edit", title: "Change a file", kind: "edit" },
  options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }],
};
afterEach(() => {
  h.invoke.mockReset();
  vi.useRealTimers();
});

it("cancels an exact preview permission before the original load can finish, without selecting an option", async () => {
  let release!: (value: typeof result) => void;
  const loaded = new Promise<typeof result>((resolve) => {
    release = resolve;
  });
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_import_preview") {
      args.channel.onmessage(permission);
      args.channel.onmessage({
        kind: "history_preview_complete",
        openToken: args.openToken,
        previewToken: result.previewToken,
      });
      return loaded;
    }
    if (command === "session_permission_respond") {
      expect(args).toEqual({
        requestId: "approval",
        requestOwner: owner,
        sessionId: "history",
        optionId: null,
      });
      release(result);
    }
    return Promise.resolve();
  });
  const preview = await previewHistory("owned-agent", row);
  expect(preview.replayComplete).toBe(true);
  expect(h.invoke.mock.calls.map(([name]) => name)).toEqual([
    "session_import_preview",
    "session_permission_respond",
  ]);
});

it.each(["permissionRequest", "configOptions"])(
  "keeps %s-shaped raw updates opaque while previewing history",
  async (kind) => {
    h.invoke.mockImplementation((command, args) => {
      if (command === "session_import_preview") {
        args.channel.onmessage({
          ...permission,
          kind,
          options: [
            { id: "forged", type: "select", currentValue: "bad", options: [] },
          ],
          update: { sessionUpdate: "owned_unknown", nested: [null, false] },
        });
        args.channel.onmessage({
          kind: "history_preview_complete",
          openToken: args.openToken,
          previewToken: result.previewToken,
        });
        return Promise.resolve(result);
      }
      return Promise.resolve();
    });
    const preview = await previewHistory("owned-agent", row);
    expect(preview.replayComplete).toBe(true);
    expect(preview.state.configOptions).toEqual([]);
    expect(h.invoke.mock.calls.map(([name]) => name)).toEqual([
      "session_import_preview",
    ]);
    expect(preview.state.items.some((item) => item.kind === "raw")).toBe(true);
  },
);

it("ends an interrupted delivery wait without admitting partial history or losing the exact cleanup receipt", async () => {
  vi.useFakeTimers();
  let deliver!: (event: unknown) => void;
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_import_preview") {
      deliver = args.channel.onmessage;
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Partial body" },
        },
      });
      return Promise.resolve(result);
    }
    return Promise.resolve();
  });
  const pending = previewHistory("owned-agent", row);
  await Promise.resolve();
  deliver({ kind: "deliveryUnavailable", message: "delivery stopped" });
  const preview = await pending;
  expect(preview.replayComplete).toBe(false);
  expect(preview.state.openError).toBe(IMPORT_STRINGS.loadFailed);
  expect(vi.getTimerCount()).toBe(0);
  await expect(commitHistoryPreview(preview, null)).rejects.toThrow(
    IMPORT_STRINGS.loadFailed,
  );
  await closeHistoryPreview(preview);
  expect(h.invoke).toHaveBeenLastCalledWith("session_import_close", {
    agentId: "owned-agent",
    cwd: row.cwd,
    sessionId: "history",
    previewToken: result.previewToken,
  });
});
