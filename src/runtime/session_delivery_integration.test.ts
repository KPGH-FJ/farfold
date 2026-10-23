import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), next: 0 }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));
import { threads } from "./sessions";
import { emitOpeningHeader } from "./session_open_test_fixture";
import { previewHistory } from "./history_import";
import { draftPersistence } from "./drafts";

const observerId = "00000000000040008000000000000001";
function send(
  args: Record<string, any>,
  event: unknown,
  sequence: number,
  sampled = false,
) {
  args.channel.onmessage({
    farfoldDelivery: {
      openToken: args.openToken,
      observerId,
      sequence: String(sequence),
      ...(sampled ? { sampleId: "1" } : {}),
    },
    event,
  });
}
function replay(
  args: Record<string, any>,
  marker: unknown,
  acknowledgmentsAfter = 1,
) {
  send(
    args,
    {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Observed body" },
      },
    },
    1,
    true,
  );
  send(args, marker, 2);
  expect(acknowledgments()).toHaveLength(acknowledgmentsAfter);
}
const acknowledgments = () =>
  h.invoke.mock.calls.filter(
    ([command]) => command === "session_delivery_observation_ack",
  );
beforeEach(() => {
  h.invoke.mockReset();
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "observes actual open/load consumption in the private view before publication (resumed=%s)",
  async (resumed) => {
    const native = `observed-open-${++h.next}`;
    const key = `observed:/work:${native}`;
    h.invoke.mockImplementation(async (command, args) => {
      if (command === "session_open") {
        emitOpeningHeader(args, {
          cwd: "/work",
          nativeSessionId: native,
          connectionId: `connection-${native}`,
        });
        replay(args, {
          kind: "session_history_complete",
          openToken: args.openToken,
        });
        return {
          nativeSessionId: native,
          connectionId: `connection-${native}`,
          cwd: "/work",
          resumed,
          configOptions: [],
          configCheck: { status: "ready", issues: [], current: {} },
        };
      }
      if (command === "session_delivery_observation_ack") {
        expect(threads.thread(key)).toBeUndefined();
        return true;
      }
      return command === "settings_get" ? null : [];
    });
    const state = await threads.open({
      agentId: "observed",
      cwd: "/work",
      ...(resumed ? { nativeSessionId: native } : { fresh: true }),
    });
    expect(state.key).toBe(key);
    expect(state.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", text: "Observed body" }),
      ]),
    );
    expect(acknowledgments()).toHaveLength(1);
    expect(acknowledgments()[0][1].receipt.outcome).toBe("consumed");
  },
);

it("observes preview consumption when the private view is actually projected before its invoked result", async () => {
  let resultReturned = false;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_import_preview") {
      replay(
        args,
        {
          kind: "history_preview_complete",
          openToken: args.openToken,
          previewToken: "preview",
        },
        1,
      );
      resultReturned = true;
      return {
        cwd: "/work",
        nativeSessionId: "original",
        connectionId: "preview-connection",
        previewToken: "preview",
        configOptions: [],
      };
    }
    if (command === "session_delivery_observation_ack") {
      expect(resultReturned).toBe(false);
      return true;
    }
    return null;
  });
  const preview = await previewHistory("observed", {
    nativeSessionId: "original",
    cwd: "/work",
    title: null,
    updatedAt: null,
    canLoad: true,
    locationAvailable: true,
    alreadyAddedId: null,
    isOpen: false,
  });
  expect(preview.state.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "agent", text: "Observed body" }),
    ]),
  );
  expect(acknowledgments()).toHaveLength(1);
  expect(acknowledgments()[0][1].receipt.outcome).toBe("consumed");
});

it("observes fork replay after private reduction before independent child publication", async () => {
  const native = `observed-parent-${++h.next}`;
  const parent = threads.markOpenFailed(
    `observed:/work:${native}`,
    "observed",
    "/work",
    native,
    "fixture",
  );
  parent.openError = null;
  parent.identity = "established";
  parent.connectionId = `parent-${native}`;
  parent.sessionOperations = { forkCurrentContext: true };
  parent.configCheck = { status: "ready", issues: [], current: {} };
  const key = `observed:/work:child-${native}`;
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "session_fork_current") {
      emitOpeningHeader(args, {
        cwd: args.cwd,
        nativeSessionId: `child-${native}`,
        connectionId: `independent-${native}`,
      });
      replay(args, {
        kind: "session_history_complete",
        openToken: args.openToken,
      });
      return {
        status: "ready",
        operationId: args.operationId,
        parentConnectionId: args.connectionId,
        parentSessionId: args.parentSessionId,
        cwd: args.cwd,
        childSessionId: `child-${native}`,
        indexed: true,
        sourceReleased: true,
        session: {
          nativeSessionId: `child-${native}`,
          connectionId: `independent-${native}`,
          cwd: args.cwd,
          resumed: true,
          configOptions: [],
          configCheck: { status: "ready", issues: [], current: {} },
          warnings: [],
          service: null,
        },
      };
    }
    if (command === "session_delivery_observation_ack") {
      expect(threads.thread(key)).toBeUndefined();
      return true;
    }
    return command === "settings_get" ? null : [];
  });
  const child = await threads.forkCurrent(parent.key);
  expect(child?.key).toBe(key);
  expect(child?.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "agent", text: "Observed body" }),
    ]),
  );
  expect(acknowledgments()).toHaveLength(1);
  expect(acknowledgments()[0][1].receipt.outcome).toBe("consumed");
});
