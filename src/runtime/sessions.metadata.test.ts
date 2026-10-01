import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
}));
import { threads, type IndexRow } from "./sessions";
import { discoverHistory, type DiscoveryPage } from "./history_import";
import {
  composerDrafts,
  draftPersistence,
  draftQueues,
  fileFeedbackDrafts,
} from "./drafts";
import { DRAFT_STORAGE_KEY } from "./draft_storage";

const row: IndexRow = {
  id: "agent:/notes:conversation",
  agentId: "agent",
  cwd: "/notes",
  nativeSessionId: "conversation",
  title: "Updated title",
  pinned: true,
  archived: false,
  configOptions: null,
  createdAt: 1,
  updatedAt: 2,
};
const settings = new Map<string, unknown>();
beforeEach(() => {
  settings.clear();
  invoke.mockImplementation(async (command: string, args) => {
    if (command === "session_index_list") return [row];
    if (command === "settings_get")
      return args.key === "autoArchiveDays"
        ? 30
        : (settings.get(args.key) ?? null);
    if (command === "settings_set") {
      settings.set(args.key, structuredClone(args.value));
      return null;
    }
    if (command === "session_meta_rename") return row;
    if (command === "agent_work_get") return { cwd: args.cwd };
    if (command === "agent_status") return [{ state: "ready", cwd: "/notes" }];
    return [];
  });
});
afterEach(async () => {
  await draftPersistence.flush();
  invoke.mockReset();
});

it("protects unsent editor text and unsubmitted file feedback from archiving", async () => {
  const key = "agent:/notes:unsent-archive";
  composerDrafts.update(`session:${key}`, () => ({
    text: "Keep this",
    attachments: [],
  }));
  expect(threads.archiveBlockReason(key)).toBe("unsent");
  await expect(threads.setArchived(key, true)).rejects.toBeTruthy();
  composerDrafts.clear(`session:${key}`);
  fileFeedbackDrafts.update(key, "report.md", {
    text: "Revise this section",
    selection: null,
  });
  expect(threads.archiveBlockReason(key)).toBe("unsent");
  await expect(threads.setArchived(key, true)).rejects.toBeTruthy();
  fileFeedbackDrafts.clear(key, "report.md");
  expect(
    invoke.mock.calls.some(([command]) => command === "session_meta_archive"),
  ).toBe(false);
  expect(threads.archiveBlockReason(key)).toBeNull();
  await threads.setArchived(key, true);
  expect(
    invoke.mock.calls.some(([command]) => command === "session_meta_archive"),
  ).toBe(true);
});

it.each(["attachment", "queue", "queueEdit"] as const)(
  "uses the same guard for an unloaded conversation with %s and allows restoration",
  async (kind) => {
    const key = `agent:/notes:archive-${kind}`;
    let clear: () => void;
    if (kind === "attachment") {
      composerDrafts.update(`session:${key}`, () => ({
        text: "",
        attachments: [{ id: "file", kind: "file", name: "notes.txt" }],
      }));
      clear = () => composerDrafts.clear(`session:${key}`);
    } else if (kind === "queue") {
      draftQueues.write(key, [[{ type: "text", text: "Later" }]], null);
      clear = () => draftQueues.write(key, [], null);
    } else {
      composerDrafts.update(`queue-edit:${key}`, () => ({
        text: "",
        attachments: [],
        queueEdit: { index: 0, original: [] },
      }));
      clear = () => composerDrafts.clear(`queue-edit:${key}`);
    }
    expect(threads.archiveBlockReason(key)).toBe("unsent");
    await expect(threads.setArchived(key, true)).rejects.toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith(
      "session_meta_archive",
      expect.anything(),
    );
    await threads.setArchived(key, false);
    expect(invoke).toHaveBeenCalledWith("session_meta_archive", {
      sessionId: key,
      archived: false,
    });
    clear();
    expect(threads.archiveBlockReason(key)).toBeNull();
  },
);

it.each([
  "running",
  "submitting",
  "configuring",
  "reconnecting",
  "stopUnconfirmed",
] as const)("does not archive a conversation while %s", async (field) => {
  const state = threads.markOpenFailed(
    `agent:/notes:archive-${field}`,
    "agent",
    "/notes",
    `archive-${field}`,
    "fixture",
  );
  state.openError = null;
  state[field] = true;
  expect(threads.archiveBlockReason(state.key)).toBe(
    field === "stopUnconfirmed" ? "unconfirmed" : field,
  );
  await expect(threads.setArchived(state.key, true)).rejects.toBeTruthy();
  expect(
    invoke.mock.calls.some(([command]) => command === "session_meta_archive"),
  ).toBe(false);
  await threads.setArchived(state.key, false);
  expect(
    invoke.mock.calls.some(([command]) => command === "session_meta_archive"),
  ).toBe(true);
  const restoreIndex = invoke.mock.calls.findIndex(
    ([command]) => command === "session_meta_archive",
  );
  expect(
    invoke.mock.calls
      .slice(0, restoreIndex)
      .some(
        ([command, args]) =>
          command === "settings_set" &&
          args.key === DRAFT_STORAGE_KEY &&
          args.value.activity[state.key]?.lastActivityAt > 0,
      ),
  ).toBe(true);
});

it("refreshes local metadata without querying connected Agents or remote history", async () => {
  await threads.refreshIndex();
  expect(threads.getSnapshot().index).toEqual([row]);
  expect(threads.getSnapshot().autoArchiveDays).toBe(30);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "session_index_list",
    "settings_get",
  ]);
});

it.each(["rename", "pin", "archive"] as const)(
  "finishes %s while an explicitly requested remote history lookup is still pending",
  async (operation) => {
    let finishDiscovery!: (page: DiscoveryPage) => void;
    const localInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation((command: string, args: unknown) =>
      command === "session_discover"
        ? new Promise<DiscoveryPage>((resolve) => {
            finishDiscovery = resolve;
          })
        : localInvoke(command, args),
    );
    let discoveryFinished = false;
    const discovery = discoverHistory(row.agentId).then(() => {
      discoveryFinished = true;
    });
    if (operation === "rename") await threads.rename(row.id, row.title!);
    else if (operation === "pin") await threads.setPinned(row.id, true);
    else await threads.setArchived(row.id, true);
    expect(discoveryFinished).toBe(false);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "session_discover",
      ...(operation === "archive" ? ["agent_work_get"] : []),
      `session_meta_${operation}`,
      "session_index_list",
      "settings_get",
    ]);
    expect(threads.getSnapshot().index).toEqual([row]);
    finishDiscovery({ status: "supported", sessions: [], nextCursor: null });
    await discovery;
    expect(discoveryFinished).toBe(true);
  },
);
