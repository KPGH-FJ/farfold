import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
}));
import { threads, type IndexRow } from "./sessions";
import { composerDrafts, draftPersistence } from "./drafts";
import { STRINGS } from "./strings";

let row: IndexRow;
let canonical: string;
let serial = 0;
beforeEach(async () => {
  const native = `archive-alias-${++serial}`;
  const raw = `/tmp/${native}`;
  canonical = `/private${raw}`;
  row = {
    id: `agent:${raw}:${native}`,
    agentId: "agent",
    cwd: raw,
    nativeSessionId: native,
    title: "Original title",
    pinned: false,
    archived: false,
    configOptions: null,
    createdAt: 1,
    updatedAt: 2,
  };
  invoke.mockImplementation(async (command: string) => {
    if (command === "session_index_list") return [row];
    if (command === "agent_work_get") return { cwd: canonical };
    if (command === "settings_get") return null;
    return null;
  });
  await draftPersistence.load();
  await threads.refreshIndex();
  invoke.mockClear();
});
afterEach(async () => {
  await draftPersistence.flush();
  invoke.mockReset();
});

it.each(["input", "running", "queue"] as const)(
  "protects canonical %s when archiving its unchanged raw directory index",
  async (kind) => {
    const key = `${row.agentId}:${canonical}:${row.nativeSessionId}`;
    const state = threads.markOpenFailed(
      key,
      row.agentId,
      canonical,
      row.nativeSessionId!,
      "fixture",
    );
    state.openError = null;
    state.connectionLost = false;
    state.resumed = true;
    if (kind === "input")
      composerDrafts.update(`session:${key}`, () => ({
        text: "Keep my unsent input",
        attachments: [],
      }));
    if (kind === "running") state.running = true;
    if (kind === "queue")
      state.queued = [[{ type: "text", text: "Keep my queued input" }]];
    const originalRow = structuredClone(row);

    await expect(threads.setArchived(row.id, true)).rejects.toBeTruthy();

    expect(invoke).not.toHaveBeenCalledWith(
      "session_meta_archive",
      expect.anything(),
    );
    expect(row).toEqual(originalRow);
    if (kind === "input") {
      expect(composerDrafts.read(`session:${key}`).text).toBe(
        "Keep my unsent input",
      );
      composerDrafts.clear(`session:${key}`);
    }
    state.running = false;
    state.queued = [];
  },
);

it.each([null, { cwd: "relative" }, { cwd: "/bad\0directory" }])(
  "does not archive when directory verification returns %j",
  async (reply) => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) =>
      command === "agent_work_get"
        ? Promise.resolve(reply)
        : normal(command, args),
    );
    await expect(threads.setArchived(row.id, true)).rejects.toThrow(
      STRINGS.repair.archiveDirectoryUnknown,
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "session_meta_archive",
      expect.anything(),
    );
  },
);

it("keeps restoration available when the directory cannot be verified", async () => {
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) =>
    command === "agent_work_get"
      ? Promise.reject(new Error("directory missing"))
      : normal(command, args),
  );
  await expect(threads.setArchived(row.id, true)).rejects.toThrow(
    STRINGS.repair.archiveDirectoryUnknown,
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "session_meta_archive",
    expect.anything(),
  );
  await threads.setArchived(row.id, false);
  expect(invoke).toHaveBeenCalledWith("session_meta_archive", {
    sessionId: row.id,
    archived: false,
  });
});

it("does not borrow busy state from another directory with the same native id", async () => {
  const key = `${row.agentId}:/another-directory:${row.nativeSessionId}`;
  const state = threads.markOpenFailed(
    key,
    row.agentId,
    "/another-directory",
    row.nativeSessionId!,
    "fixture",
  );
  state.running = true;
  await threads.setArchived(row.id, true);
  expect(invoke).toHaveBeenCalledWith("session_meta_archive", {
    sessionId: row.id,
    archived: true,
    expectedCwd: canonical,
  });
  state.running = false;
});

it("rechecks input typed while directory verification is pending", async () => {
  let resolve!: (value: { cwd: string }) => void;
  const gate = new Promise<{ cwd: string }>((done) => {
    resolve = done;
  });
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) =>
    command === "agent_work_get" ? gate : normal(command, args),
  );
  const action = threads.setArchived(row.id, true);
  const key = `session:${row.agentId}:${canonical}:${row.nativeSessionId}`;
  composerDrafts.update(key, () => ({
    text: "Typed during the check",
    attachments: [],
  }));
  resolve({ cwd: canonical });
  await expect(action).rejects.toThrow(STRINGS.repair.archiveBusy);
  expect(invoke).not.toHaveBeenCalledWith(
    "session_meta_archive",
    expect.anything(),
  );
  expect(composerDrafts.read(key).text).toBe("Typed during the check");
  composerDrafts.clear(key);
});

it("does not archive while unsent persistence has failed", async () => {
  const normal = invoke.getMockImplementation()!;
  let fail = true;
  invoke.mockImplementation((command, args) =>
    command === "settings_set" && fail
      ? Promise.reject(new Error("disk unavailable"))
      : normal(command, args),
  );
  const key = "session:agent:/another-directory:save-failure";
  composerDrafts.update(key, () => ({
    text: "Keep this too",
    attachments: [],
  }));
  await expect(threads.setArchived(row.id, true)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalledWith(
    "session_meta_archive",
    expect.anything(),
  );
  expect(composerDrafts.read(key).text).toBe("Keep this too");
  fail = false;
  composerDrafts.clear(key);
});

it("rechecks canonical input typed while an earlier save is waiting", async () => {
  let release!: () => void;
  let started!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const saved = new Promise<void>((done) => {
    release = done;
  });
  let first = true;
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => {
    if (command === "settings_set" && first) {
      first = false;
      started();
      return saved;
    }
    return normal(command, args);
  });
  const other = "session:agent:/another-directory:save-wait";
  composerDrafts.update(other, () => ({
    text: "An earlier edit",
    attachments: [],
  }));
  await began;
  const action = threads.setArchived(row.id, true);
  await Promise.resolve();
  const key = `session:${row.agentId}:${canonical}:${row.nativeSessionId}`;
  composerDrafts.update(key, () => ({
    text: "Typed during the save",
    attachments: [],
  }));
  expect(invoke).not.toHaveBeenCalledWith(
    "session_meta_archive",
    expect.anything(),
  );
  release();
  await expect(action).rejects.toThrow(STRINGS.repair.archiveBusy);
  expect(invoke).not.toHaveBeenCalledWith(
    "session_meta_archive",
    expect.anything(),
  );
  expect(composerDrafts.read(key).text).toBe("Typed during the save");
  composerDrafts.clear(key);
  composerDrafts.clear(other);
});
