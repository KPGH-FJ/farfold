import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
}));
import {
  applyUpdate,
  freshThreadState,
  threads,
  type IndexRow,
} from "./sessions";
import { emitOpeningHeader } from "./session_open_test_fixture";

let stored: IndexRow;
let channel: { onmessage: (event: unknown) => void };
beforeEach(() => {
  stored = {
    id: "title-agent:/notes:cold-title",
    agentId: "title-agent",
    cwd: "/notes",
    nativeSessionId: "cold-title",
    title: "My chosen title",
    configOptions: null,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  };
  invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === "session_open") {
        channel = args.channel as typeof channel;
        const result = {
          nativeSessionId: stored.nativeSessionId!,
          connectionId: "cold-title-connection",
          cwd: stored.cwd,
          resumed: true,
          configOptions: [],
          warnings: [],
        };
        emitOpeningHeader(
          { channel, openToken: args.openToken as string },
          result,
        );
        channel.onmessage({
          update: {
            sessionUpdate: "session_info_update",
            title: "Old Agent title",
          },
        });
        channel.onmessage({
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Saved conversation" },
          },
        });
        channel.onmessage({
          kind: "session_history_complete",
          openToken: args.openToken,
        });
        return result;
      }
      if (command === "session_index_list") return [stored];
      if (command === "settings_get") return 0;
      if (command === "session_meta_rename") {
        stored = { ...stored, title: args.title as string };
        return stored;
      }
      return undefined;
    },
  );
});
afterEach(async () => {
  await threads.close(stored.id);
  invoke.mockReset();
});

it("loads the saved local title before replay and never persists an Agent replay over it", async () => {
  const state = await threads.open({
    agentId: stored.agentId,
    cwd: stored.cwd,
    nativeSessionId: stored.nativeSessionId!,
  });
  expect(state.title).toBe("My chosen title");
  expect(
    invoke.mock.calls.some(([command]) => command === "session_touch"),
  ).toBe(false);
});

it("keeps an explicit rename in memory during running Agent title updates", async () => {
  const state = await threads.open({
    agentId: stored.agentId,
    cwd: stored.cwd,
    nativeSessionId: stored.nativeSessionId!,
  });
  state.running = true;
  await threads.rename(stored.id, "My new name");
  expect(state.title).toBe("My new name");
  invoke.mockClear();
  channel.onmessage({
    update: {
      sessionUpdate: "session_info_update",
      title: "Later generated Agent title",
    },
  });
  expect(state.title).toBe("My new name");
  expect(
    invoke.mock.calls.some(([command]) => command === "session_touch"),
  ).toBe(false);
});

it("accepts the first Agent title for an unnamed draft, then retains the local name", () => {
  const state = freshThreadState(
    "title-agent:/notes:draft",
    "title-agent",
    "/notes",
    "draft",
  );
  applyUpdate(state, {
    sessionUpdate: "session_info_update",
    title: "First generated name",
  });
  expect(state.title).toBe("First generated name");
  expect(state.metaDirty).toBe(true);
  state.metaDirty = false;
  applyUpdate(state, {
    sessionUpdate: "session_info_update",
    title: "Later generated name",
  });
  expect(state.title).toBe("First generated name");
  expect(state.metaDirty).toBe(false);
});

it("publishes a confirmed rename before a following index refresh finishes", async () => {
  const state = await threads.open({
    agentId: stored.agentId,
    cwd: stored.cwd,
    nativeSessionId: stored.nativeSessionId!,
  });
  let finishRefresh!: (rows: IndexRow[]) => void;
  const localInvoke = invoke.getMockImplementation()!;
  invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
    command === "session_index_list"
      ? new Promise<IndexRow[]>((resolve) => {
          finishRefresh = resolve;
        })
      : localInvoke(command, args),
  );
  const observed: (string | null)[] = [];
  const unsubscribe = threads.subscribe(() =>
    observed.push(
      threads.getSnapshot().index.find((row) => row.id === stored.id)?.title ??
        null,
    ),
  );
  try {
    const rename = threads.rename(stored.id, "Immediately visible name");
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    expect(state.title).toBe("Immediately visible name");
    expect(observed).toContain("Immediately visible name");
    finishRefresh([stored]);
    await rename;
  } finally {
    unsubscribe();
  }
});
