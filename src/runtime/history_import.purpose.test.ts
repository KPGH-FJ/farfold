import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import {
  closeHistoryPreview,
  commitHistoryPreview,
  hasPreviewContent,
  previewHistory,
  readHistoryPreview,
  type DiscoveredConversation,
} from "./history_import";
import { IMPORT_STRINGS as S } from "./import_strings";

const row: DiscoveredConversation = {
  nativeSessionId: "original-owned-history",
  cwd: "/owned-history-preview",
  title: "Original owned history",
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
interface Wire {
  agentId: string;
  cwd: string;
  sessionId: string;
  openToken: string;
  admissionChannel: unknown;
  channel: { onmessage(event: unknown): void };
}
function result(purpose: unknown) {
  return {
    cwd: row.cwd,
    nativeSessionId: row.nativeSessionId,
    connectionId: "owned-preview-connection",
    previewToken: "exact-owned-preview-token",
    configOptions: [],
    ...(purpose === undefined ? {} : { purpose }),
  };
}
function deliver(wire: Wire) {
  wire.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Actual controlled history body" },
    },
  });
  wire.channel.onmessage({
    kind: "history_preview_complete",
    openToken: wire.openToken,
    previewToken: "exact-owned-preview-token",
  });
}
function respond(purpose: unknown) {
  h.invoke.mockImplementation(async (command: string, wire: Wire) => {
    if (
      command === "session_import_preview" ||
      command === "session_read_preview"
    ) {
      deliver(wire);
      return result(purpose);
    }
    if (command === "session_import_commit") return { id: "owned-index-row" };
    if (command === "session_import_close") return;
    throw new Error(`unexpected controlled command: ${command}`);
  });
}
function exactClose() {
  return {
    agentId: "owned-agent",
    cwd: row.cwd,
    sessionId: row.nativeSessionId,
    previewToken: "exact-owned-preview-token",
  };
}
beforeEach(() => {
  h.invoke.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps the explicit import preview and commit path compatible", async () => {
  respond("importPreview");
  const preview = await previewHistory("owned-agent", row);
  expect(preview.purpose).toBe("importPreview");
  expect(hasPreviewContent(preview)).toBe(true);
  await commitHistoryPreview(preview, row.title);
  await closeHistoryPreview(preview);
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "session_import_preview",
    "session_import_commit",
    "session_import_close",
  ]);
});

it("reads through the fixed read-only wrapper with the same exact owner fields", async () => {
  respond("searchReadOnly");
  const preview = await readHistoryPreview("owned-agent", row);
  expect(preview.purpose).toBe("searchReadOnly");
  expect(hasPreviewContent(preview)).toBe(true);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "session_read_preview",
    expect.objectContaining({
      agentId: "owned-agent",
      cwd: row.cwd,
      sessionId: row.nativeSessionId,
      openToken: expect.any(String),
      admissionChannel: expect.anything(),
      channel: expect.anything(),
    }),
  );
  expect(Object.keys(h.invoke.mock.calls[0][1]).sort()).toEqual(
    [
      "agentId",
      "cwd",
      "sessionId",
      "openToken",
      "admissionChannel",
      "channel",
    ].sort(),
  );
  await closeHistoryPreview(preview);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "session_import_close",
    exactClose(),
  );
});

it("never commits a readable search-only token as an import", async () => {
  respond("searchReadOnly");
  const preview = await readHistoryPreview("owned-agent", row);
  expect(hasPreviewContent(preview)).toBe(true);
  await expect(commitHistoryPreview(preview, row.title)).rejects.toThrow(
    S.loadFailed,
  );
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "session_read_preview",
  ]);
  await closeHistoryPreview(preview);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "session_import_close",
    exactClose(),
  );
});

it("does not promote a search-purpose reply received by the import wrapper", async () => {
  respond("searchReadOnly");
  const preview = await previewHistory("owned-agent", row);
  expect(preview.purpose).toBeNull();
  expect(preview.replayComplete).toBe(false);
  expect(preview.state.items).toEqual([]);
  await expect(commitHistoryPreview(preview, row.title)).rejects.toThrow(
    S.loadFailed,
  );
  await closeHistoryPreview(preview);
  expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
    "session_import_preview",
    "session_import_close",
  ]);
});

it.each([undefined, "importPreview", "unrecognized-purpose"])(
  "retains only cleanup ownership for a read receipt with purpose %s",
  async (purpose) => {
    respond(purpose);
    const preview = await readHistoryPreview("owned-agent", row);
    expect(preview.purpose).toBeNull();
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
    expect(preview.state.openError).toBe(S.loadFailed);
    await expect(commitHistoryPreview(preview, row.title)).rejects.toThrow(
      S.loadFailed,
    );
    await closeHistoryPreview(preview);
    expect(h.invoke).toHaveBeenLastCalledWith(
      "session_import_close",
      exactClose(),
    );
  },
);

it.each(["signal", "interest"])(
  "does not publish late readable history after %s retires its owner",
  async (mode) => {
    const controller = new AbortController();
    let current = true;
    let wire!: Wire;
    let finish!: () => void;
    h.invoke.mockImplementation((command: string, args: Wire) => {
      if (command === "session_read_preview") {
        wire = args;
        return new Promise((resolve) => {
          finish = () => resolve(result("searchReadOnly"));
        });
      }
      if (command === "session_import_close") return Promise.resolve();
      throw new Error(`unexpected controlled command: ${command}`);
    });
    const pending = readHistoryPreview("owned-agent", row, {
      inquirySignal: controller.signal,
      inquiryCurrent: () => current,
    });
    if (mode === "signal") controller.abort();
    else current = false;
    deliver(wire);
    finish();
    const preview = await pending;
    expect(preview.replayComplete).toBe(false);
    expect(preview.state.items).toEqual([]);
    expect(hasPreviewContent(preview)).toBe(false);
    await closeHistoryPreview(preview);
    expect(h.invoke).toHaveBeenLastCalledWith(
      "session_import_close",
      exactClose(),
    );
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "session_read_preview",
      "session_import_close",
    ]);
  },
);

it("does not dispatch an already retired read interest", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    readHistoryPreview("owned-agent", row, {
      inquirySignal: controller.signal,
    }),
  ).rejects.toThrow(S.loadFailed);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("does not revive a retired interest when its value changes back before the reply", async () => {
  let current = true;
  let wire!: Wire;
  let finish!: () => void;
  h.invoke.mockImplementation((command: string, args: Wire) => {
    if (command === "session_read_preview") {
      wire = args;
      return new Promise((resolve) => {
        finish = () => resolve(result("searchReadOnly"));
      });
    }
    if (command === "session_import_close") return Promise.resolve();
    throw new Error(`unexpected controlled command: ${command}`);
  });
  const pending = readHistoryPreview("owned-agent", row, {
    inquiryCurrent: () => current,
  });
  current = false;
  deliver(wire);
  current = true;
  deliver(wire);
  finish();
  const preview = await pending;
  expect(preview.replayComplete).toBe(false);
  expect(preview.state.items).toEqual([]);
  await closeHistoryPreview(preview);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "session_import_close",
    exactClose(),
  );
});

it("ends a marker wait on explicit view retirement without publishing its prefix", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  h.invoke.mockImplementation(async (command: string) => {
    if (command === "session_read_preview") return result("searchReadOnly");
    if (command === "session_import_close") return;
    throw new Error(`unexpected controlled command: ${command}`);
  });
  const pending = readHistoryPreview("owned-agent", row, {
    inquirySignal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();
  const preview = await pending;
  expect(preview.replayComplete).toBe(false);
  expect(preview.state.items).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  await closeHistoryPreview(preview);
});
