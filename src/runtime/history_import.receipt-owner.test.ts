import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import {
  closeHistoryPreview,
  commitHistoryPreview,
  hasPreviewContent,
  historyContinuation,
  previewHistory,
  type DiscoveredConversation,
} from "./history_import";
import { IMPORT_STRINGS as S } from "./import_strings";

const row: DiscoveredConversation = {
  nativeSessionId: "requested-native",
  cwd: "/requested-preview",
  title: "Original title",
  updatedAt: null,
  canLoad: true,
  locationAvailable: true,
  alreadyAddedId: null,
  isOpen: false,
};
interface Wire {
  openToken: string;
  channel: { onmessage(event: unknown): void };
}
function reply() {
  return {
    cwd: "/canonical-preview",
    nativeSessionId: "actual-acknowledged-native",
    connectionId: "actual-preview-connection",
    previewToken: "actual-owned-token",
    configOptions: [],
  };
}
function readable(wire: Wire) {
  wire.channel.onmessage({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Actual Agent history" },
    },
  });
}
function marker(wire: Wire) {
  wire.channel.onmessage({
    kind: "history_preview_complete",
    openToken: wire.openToken,
    previewToken: reply().previewToken,
  });
}
function exactClose() {
  return {
    agentId: "owner-agent",
    cwd: reply().cwd,
    sessionId: reply().nativeSessionId,
    previewToken: reply().previewToken,
  };
}
beforeEach(() => {
  h.invoke.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("retains the acknowledged exact preview owner after local history conversion fails, and keeps failed close retryable", async () => {
  let deliver!: (event: unknown) => void;
  let openToken!: string;
  let closeCount = 0;
  h.invoke.mockImplementation(async (name: string, args: Wire) => {
    if (name === "session_import_preview") {
      deliver = args.channel.onmessage;
      openToken = args.openToken;
      readable(args);
      args.channel.onmessage({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: JSON.parse('{"toString":null,"valueOf":null}'),
        },
      });
      marker(args);
      return reply();
    }
    if (name === "session_import_close") {
      closeCount++;
      if (closeCount === 1)
        throw new Error("exact owner close remains unconfirmed");
      return;
    }
    throw new Error(`unexpected command: ${name}`);
  });
  const original = structuredClone(row);
  const preview = await previewHistory("owner-agent", row);
  expect(preview).toMatchObject({
    agentId: "owner-agent",
    cwd: reply().cwd,
    nativeSessionId: reply().nativeSessionId,
    previewToken: reply().previewToken,
    replayComplete: false,
  });
  expect(preview.state.openError).toBe(S.loadFailed);
  expect(hasPreviewContent(preview)).toBe(false);
  expect(historyContinuation(preview).title).toBe(S.bodyUnavailable);
  await expect(commitHistoryPreview(preview, row.title)).rejects.toThrow(
    S.loadFailed,
  );
  expect(h.invoke.mock.calls.map(([name]) => name)).toEqual([
    "session_import_preview",
  ]);
  const before = structuredClone(preview.state);
  deliver({
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "LATE_MUST_NOT_REPAIR" },
    },
  });
  marker({ openToken, channel: { onmessage: deliver } });
  expect(preview.state).toEqual(before);
  expect(preview.replayComplete).toBe(false);
  await expect(closeHistoryPreview(preview)).rejects.toThrow(
    "exact owner close remains unconfirmed",
  );
  await closeHistoryPreview(preview);
  expect(
    h.invoke.mock.calls
      .filter(([name]) => name === "session_import_close")
      .map(([, args]) => args),
  ).toEqual([exactClose(), exactClose()]);
  expect(row).toEqual(original);
});

it("keeps the cleanup receipt even when returned configuration conversion fails before replay projection", async () => {
  h.invoke.mockImplementation(async (name: string, args: Wire) => {
    if (name === "session_import_preview") {
      readable(args);
      marker(args);
      return {
        ...reply(),
        configOptions: [
          {
            id: JSON.parse('{"toString":null,"valueOf":null}'),
            type: "boolean",
            currentValue: false,
          },
        ],
      };
    }
    if (name === "session_import_close") return;
    throw new Error(`unexpected command: ${name}`);
  });
  const preview = await previewHistory("owner-agent", row);
  expect(preview.previewToken).toBe(reply().previewToken);
  expect(preview.replayComplete).toBe(false);
  expect(preview.state.openError).toBe(S.loadFailed);
  expect(hasPreviewContent(preview)).toBe(false);
  await expect(commitHistoryPreview(preview, row.title)).rejects.toThrow(
    S.loadFailed,
  );
  await closeHistoryPreview(preview);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "session_import_close",
    exactClose(),
  );
  expect(
    h.invoke.mock.calls.some(([name]) => name === "session_import_commit"),
  ).toBe(false);
});

it("still rejects the original unsuccessful invoke without inventing an acknowledged cleanup owner", async () => {
  const remoteFailure = new Error("original official load failed");
  h.invoke.mockImplementation(async (name: string, args: Wire) => {
    expect(name).toBe("session_import_preview");
    readable(args);
    marker(args);
    throw remoteFailure;
  });
  await expect(previewHistory("owner-agent", row)).rejects.toBe(remoteFailure);
  expect(h.invoke).toHaveBeenCalledTimes(1);
});

it("preserves successful prefix admission and the original explicit commit and close commands", async () => {
  h.invoke.mockImplementation(async (name: string, args: Wire) => {
    if (name === "session_import_preview") {
      readable(args);
      marker(args);
      return reply();
    }
    if (name === "session_import_commit") return { id: "actual-index-row" };
    if (name === "session_import_close") return;
    throw new Error(`unexpected command: ${name}`);
  });
  const preview = await previewHistory("owner-agent", row);
  expect(preview.replayComplete).toBe(true);
  expect(hasPreviewContent(preview)).toBe(true);
  expect(preview.state.openError).toBeNull();
  expect(preview.state.items[0]).toMatchObject({
    kind: "agent",
    text: "Actual Agent history",
    time: 0,
  });
  expect(h.invoke).toHaveBeenCalledTimes(1);
  await commitHistoryPreview(preview, row.title);
  expect(h.invoke).toHaveBeenLastCalledWith("session_import_commit", {
    ...exactClose(),
    title: row.title,
  });
  await closeHistoryPreview(preview);
  expect(h.invoke).toHaveBeenLastCalledWith(
    "session_import_close",
    exactClose(),
  );
});
