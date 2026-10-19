import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads, type IndexRow, type OpenResult } from "./sessions";
import { HistoryReplayBuffer } from "./history_replay";
import { draftPersistence } from "./drafts";
import {
  closeHistoryPreview,
  hasPreviewContent,
  previewHistory,
  type HistoryPreview,
} from "./history_import";

type Role = "open" | "fork" | "preview";
type Wire = {
  channel: { onmessage(event: unknown): void };
  admissionChannel?: { onmessage(event: unknown): void };
  openToken: string;
  operationId: string;
  connectionId: string;
  parentSessionId: string;
};
type OwnedEvent = {
  update: { sessionUpdate: string; ownedRole: Role; text: string };
  unknownEnvelope: unknown;
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const agentId = "owned-staging",
  cwd = "/owned-staging";
const result = (nativeSessionId: string, connectionId: string): OpenResult => ({
  cwd,
  nativeSessionId,
  connectionId,
  resumed: true,
  configOptions: [],
  configCheck: { status: "ready", issues: [], current: {} },
  warnings: [],
  service: null,
});

// Characterization, not a capacity RED, allocation/RSS claim or real Agent test.
// These are three ACTUAL renderer entry paths, unlike the old three labels on
// the common primitive. Only the Tauri boundary/draft flush are controlled.
it("observes three real flow-owned replay buffers while their original delivery owners are pending", async () => {
  const index = deferred<IndexRow[]>(),
    previewReply = deferred<OpenResult & { previewToken: string }>();
  const received = deferred<void>();
  const tokens = new Map<Role, string>();
  const owners = new Map<
    Role,
    { buffer: HistoryReplayBuffer; event: OwnedEvent }
  >();
  const wires = new Map<Role, Wire>();
  const push = HistoryReplayBuffer.prototype.push;
  const spy = vi
    .spyOn(HistoryReplayBuffer.prototype, "push")
    .mockImplementation(function (this: HistoryReplayBuffer, event: unknown) {
      push.call(this, event);
      const owned = event as OwnedEvent | null;
      const role = owned?.update?.ownedRole;
      if (role === "open" || role === "fork" || role === "preview") {
        owners.set(role, { buffer: this, event: owned! });
        if (owners.size === 3) received.resolve(undefined);
      }
    });
  const flush = vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  let indexCalls = 0;
  const deliver = (role: Role, wire: Wire) => {
    wires.set(role, wire);
    wire.admissionChannel?.onmessage({
      kind: "session_history_admission",
      openToken: wire.openToken,
      phase: "starting",
      historyDelivery: {
        receiptId: { open: 201, fork: 202, preview: 203 }[role],
        openToken: wire.openToken,
      },
    });
    const token = role === "preview" ? "owned-preview-token" : wire.openToken;
    tokens.set(role, token);
    wire.channel.onmessage({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Readable ${role} history` },
      },
    });
    wire.channel.onmessage({
      // An own update with control-like keys is still a raw opaque envelope.
      kind: "session_history_complete",
      openToken: token,
      update: {
        sessionUpdate: "owned_opaque_staging",
        ownedRole: role,
        text: `${role}:${"x".repeat(64 * 1024)}`,
      },
      unknownEnvelope: { nested: [null, false, "🙂"], role },
    });
    wire.channel.onmessage(
      role === "preview"
        ? { kind: "history_preview_complete", previewToken: token }
        : { kind: "session_history_complete", openToken: token },
    );
    if (role === "open") {
      wire.channel.onmessage({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "owned-live-tool",
          title: "Owned live tool",
          status: "in_progress",
        },
      });
      wire.channel.onmessage({
        kind: "toolActivity",
        toolCallIds: ["owned-live-tool"],
      });
    }
  };
  h.invoke.mockImplementation((command: string, args: Wire) => {
    if (command === "session_history_delivery_ack")
      return Promise.resolve({
        receiptId: (args as unknown as { receiptId: number }).receiptId,
        openToken: args.openToken,
        outcome: "acknowledged",
      });
    if (command === "session_index_list") {
      indexCalls++;
      return index.promise;
    }
    if (command === "session_open") {
      deliver("open", args);
      return Promise.resolve(result("open-history", "open-connection"));
    }
    if (command === "session_fork_current") {
      deliver("fork", args);
      return Promise.resolve({
        status: "ready",
        operationId: args.operationId,
        parentConnectionId: args.connectionId,
        parentSessionId: args.parentSessionId,
        cwd,
        childSessionId: "fork-child",
        indexed: true,
        sourceReleased: true,
        session: result("fork-child", "fork-child-connection"),
      });
    }
    if (command === "session_import_preview") {
      deliver("preview", args);
      return previewReply.promise;
    }
    return Promise.resolve(command === "settings_get" ? null : []);
  });
  const parent = threads.markOpenFailed(
    `${agentId}:${cwd}:fork-parent`,
    agentId,
    cwd,
    "fork-parent",
    "owned seed",
  );
  parent.openError = null;
  parent.identity = "established";
  parent.connectionId = "fork-parent-connection";
  parent.sessionOperations = { forkCurrentContext: true };
  parent.configCheck = { status: "ready", issues: [], current: {} };
  parent.items = [
    {
      kind: "agent",
      id: "parent",
      text: "Keep parent body",
      streaming: false,
      time: 1,
    },
  ];
  const beforeParent = structuredClone(parent.items);
  let preview: HistoryPreview | undefined;
  const opened = threads.open({
    agentId,
    cwd,
    nativeSessionId: "open-history",
  });
  const forked = threads.forkCurrent(parent.key);
  const previewed = previewHistory(agentId, {
    nativeSessionId: "preview-history",
    cwd,
    title: null,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId: null,
    isOpen: false,
  }).then((value) => {
    preview = value;
    return value;
  });
  // A real early failure ends the observation instead of hiding behind a marker wait.
  for (const operation of [opened, forked, previewed])
    void operation.catch(received.reject);
  const settled = Promise.allSettled([opened, forked, previewed]);
  try {
    await received.promise;
    await Promise.resolve();
    expect(owners.size).toBe(3);
    expect(
      new Set([...owners.values()].map((value) => value.buffer)).size,
    ).toBe(3);
    let asciiBodyUnits = 0;
    for (const [role, { buffer, event }] of owners) {
      expect([...buffer.prefixEvents(tokens.get(role)!)]).toContain(event);
      expect(event.update.ownedRole).toBe(role);
      expect(event.unknownEnvelope).toEqual({
        nested: [null, false, "🙂"],
        role,
      });
      asciiBodyUnits += event.update.text.length;
    }
    expect(asciiBodyUnits).toBe(
      3 * 64 * 1024 + "open:".length + "fork:".length + "preview:".length,
    );
    expect(parent.items).toEqual(beforeParent);
    expect(preview).toBeUndefined();
    expect(
      h.invoke.mock.calls.filter(
        ([name]) => name === "session_history_delivery_ack",
      ),
    ).toHaveLength(0);
    // Current native gate is OUTSIDE this mock: three RPCs do not prove that
    // three native cold permits or three actual Agents ran concurrently.
    console.info(
      JSON.stringify({
        kind: "actual-renderer-three-flow-staging",
        distinctFlowBuffers: owners.size,
        opaqueAsciiBodyCodeUnits: asciiBodyUnits,
        heldIndexCalls: indexCalls,
        realRendererEntrypoints: true,
        nativeGateMeasured: false,
        rssMeasured: false,
      }),
    );
    index.resolve([]);
    previewReply.resolve({
      ...result("preview-history", "preview-connection"),
      previewToken: "owned-preview-token",
    });
    const [openState, child, previewState] = await Promise.all([
      opened,
      forked,
      previewed,
    ]);
    expect(parent.items).toEqual(beforeParent);
    expect(openState.activeToolCallIds).toEqual(["owned-live-tool"]);
    expect(child?.nativeSessionId).toBe("fork-child");
    expect(hasPreviewContent(previewState)).toBe(true);
    for (const [role, state] of [
      ["open", openState],
      ["fork", child],
      ["preview", previewState.state],
    ] as const) {
      expect(
        state?.items.some(
          (item) =>
            item.kind === "raw" &&
            item.update === owners.get(role)!.event.update,
        ),
      ).toBe(true);
    }
    expect(
      h.invoke.mock.calls.filter(
        ([name]) => name === "session_history_delivery_ack",
      ),
    ).toHaveLength(3);
    const deliveries = h.invoke.mock.calls
      .filter(([name]) => name === "session_history_delivery_ack")
      .map(([, args]) => (args as { receiptId: number }).receiptId);
    expect(deliveries.sort()).toEqual([201, 202, 203]);
    expect(
      h.invoke.mock.calls.some(
        ([name]) => name === "session_prompt" || name === "session_cancel",
      ),
    ).toBe(false);
  } finally {
    // Release all controlled waits before awaiting cleanup, even after assertion failure.
    index.resolve([]);
    previewReply.resolve({
      ...result("preview-history", "preview-connection"),
      previewToken: "owned-preview-token",
    });
    await settled;
    const openWire = wires.get("open");
    openWire?.channel.onmessage({ kind: "toolActivity", toolCallIds: [] });
    try {
      if (preview) await closeHistoryPreview(preview);
      for (const key of [
        `${agentId}:${cwd}:open-history`,
        `${agentId}:${cwd}:fork-child`,
        parent.key,
      ]) {
        if (threads.thread(key)) await threads.close(key);
      }
    } finally {
      spy.mockRestore();
      flush.mockRestore();
      h.invoke.mockReset();
    }
  }
});
