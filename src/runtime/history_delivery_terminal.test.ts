import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { draftPersistence } from "./drafts";
import { HistoryReplayProjection } from "./history_replay_projection";
import {
  previewHistory,
  closeHistoryPreview,
  commitHistoryPreview,
  hasPreviewContent,
} from "./history_import";
type Port = { onmessage(event: unknown): void };
type ForkWire = {
  channel: Port;
  admissionChannel: Port;
  openToken: string;
  operationId: string;
  connectionId: string;
  parentSessionId: string;
};
const keys: string[] = [];
const acks = () =>
  h.invoke.mock.calls.filter(
    ([name]) => name === "session_history_delivery_ack",
  );
afterEach(async () => {
  for (const key of keys.splice(0))
    if (threads.thread(key)) await threads.close(key);
  vi.restoreAllMocks();
  h.invoke.mockReset();
});
it("a real fork unknown receipt retains its body observer until a verified terminal delivery, without retry or touching parent history", async () => {
  const agentId = "owned-fork-retirement",
    cwd = "/owned-fork-retirement";
  const parent = threads.markOpenFailed(
    `${agentId}:${cwd}:parent`,
    agentId,
    cwd,
    "parent",
    "owned",
  );
  keys.push(parent.key);
  parent.openError = null;
  parent.identity = "established";
  parent.connectionId = "parent-owner";
  parent.sessionOperations = { forkCurrentContext: true };
  parent.configCheck = { status: "ready", issues: [], current: {} };
  parent.items = [
    {
      kind: "agent",
      id: "parent-body",
      text: "Keep original parent",
      streaming: false,
      time: 1,
    },
  ];
  const original = structuredClone(parent.items);
  const project = vi.spyOn(HistoryReplayProjection.prototype, "push");
  const take = vi.spyOn(HistoryReplayProjection.prototype, "take");
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  let wire!: ForkWire;
  let receipt!: Record<string, unknown>;
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_fork_current") {
      wire = args;
      args.admissionChannel.onmessage({
        kind: "session_history_admission",
        openToken: args.openToken,
        phase: "starting",
        historyDelivery: { receiptId: 601, openToken: args.openToken },
      });
      // The independent channel can identify its private child before an
      // older still-unknown RPC snapshot reaches this renderer.
      args.channel.onmessage({
        kind: "sessionOpening",
        openToken: args.openToken,
        cwd,
        sessionId: "uncertain-owned-child",
        connectionId: "independent-uncertain-child",
      });
      args.channel.onmessage({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retain uncertain child prefix" },
        },
      });
      receipt = {
        status: "unknown",
        operationId: args.operationId,
        parentConnectionId: args.connectionId,
        parentSessionId: args.parentSessionId,
        cwd,
        childSessionId: null,
        indexed: false,
        sourceReleased: false,
        session: null,
        reason: "pending",
      };
      return Promise.resolve(receipt);
    }
    if (command === "session_history_delivery_ack")
      return Promise.resolve({
        receiptId: args.receiptId,
        openToken: args.openToken,
        outcome: "acknowledged",
      });
    return Promise.resolve(command === "settings_get" ? null : []);
  });
  expect(await threads.forkCurrent(parent.key)).toBeUndefined();
  expect(acks()).toHaveLength(0);
  expect(parent.items).toEqual(original);
  expect(parent.forkOperation?.status).toBe("unknown");
  expect(project).toHaveBeenCalledTimes(1);
  const staged = project.mock.contexts[0] as HistoryReplayProjection;
  expect(staged.state?.items).toEqual([
    expect.objectContaining({ text: "Retain uncertain child prefix" }),
  ]);
  expect(take).not.toHaveBeenCalled();
  wire.channel.onmessage({
    kind: "forkResult",
    operationId: wire.operationId,
    settled: true,
    result: {
      ...receipt,
      status: "rejected",
      sourceReleased: true,
      reason: "owner_ended",
    },
  });
  await vi.waitFor(() => expect(acks()).toHaveLength(1));
  expect(staged.state).toBeUndefined();
  project.mockClear();
  wire.channel.onmessage({
    update: { sessionUpdate: "late_uncertain_child", exact: [null, false] },
  });
  expect(project).not.toHaveBeenCalled();
  expect(take).not.toHaveBeenCalled();
  expect(parent.items).toEqual(original);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "session_fork_current"),
  ).toHaveLength(1);
  expect(
    h.invoke.mock.calls.some(
      ([name]) => name === "session_prompt" || name === "session_cancel",
    ),
  ).toBe(false);
});
it("local preview conversion failure retires only staging and preserves the independent exact cleanup receipt and commit rejection", async () => {
  const row = {
    cwd: "/owned-preview",
    nativeSessionId: "original",
    title: null,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId: null,
    isOpen: false,
  };
  h.invoke.mockImplementation((command, args) => {
    if (command === "session_import_preview") {
      args.admissionChannel.onmessage({
        kind: "session_history_admission",
        openToken: args.openToken,
        phase: "starting",
        historyDelivery: { receiptId: 602, openToken: args.openToken },
      });
      args.channel.onmessage({
        kind: "history_preview_complete",
        openToken: args.openToken,
        previewToken: "exact-preview-close",
      });
      return Promise.resolve({
        cwd: row.cwd,
        nativeSessionId: row.nativeSessionId,
        connectionId: "preview-owner",
        previewToken: "exact-preview-close",
        resumed: true,
        warnings: [],
        configOptions: [
          {
            id: JSON.parse('{"toString":null,"valueOf":null}'),
            type: "boolean",
            currentValue: false,
          },
        ],
      });
    }
    if (command === "session_history_delivery_ack")
      return Promise.resolve({
        receiptId: args.receiptId,
        openToken: args.openToken,
        outcome: "acknowledged",
      });
    if (command === "session_import_close") return Promise.resolve();
    return Promise.resolve([]);
  });
  const preview = await previewHistory("owned-preview-agent", row);
  expect(preview.previewToken).toBe("exact-preview-close");
  expect(preview.replayComplete).toBe(false);
  expect(hasPreviewContent(preview)).toBe(false);
  await expect(commitHistoryPreview(preview, null)).rejects.toThrow();
  await vi.waitFor(() => expect(acks()).toHaveLength(1));
  expect(
    h.invoke.mock.calls.some(([name]) => name === "session_import_close"),
  ).toBe(false);
  await closeHistoryPreview(preview);
  expect(
    h.invoke.mock.calls
      .filter(([name]) => name === "session_import_close")
      .map(([, args]) => args),
  ).toEqual([
    {
      agentId: "owned-preview-agent",
      cwd: row.cwd,
      sessionId: "original",
      previewToken: "exact-preview-close",
    },
  ]);
});
