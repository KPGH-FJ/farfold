import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadState } from "./session_types";
import type { IndexRow } from "./sessions";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  archive: vi.fn(),
  rows: [] as IndexRow[],
  live: new Map<string, ThreadState>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", async () => ({
  ...(await import("./session_types")),
  threads: {
    getSnapshot: () => ({ index: h.rows, autoArchiveDays: 7 }),
    thread: (key: string) => h.live.get(key),
    needsAttention: () => false,
    setArchived: h.archive,
    subscribe: () => () => {},
  },
}));
const now = 20 * 86_400_000;
function baseline() {
  return {
    version: 1,
    composers: {} as Record<string, unknown>,
    feedback: {},
    queues: {},
    choice: { agentId: null, cwd: null, service: null, config: {} },
    activity: { a: { lastActivityAt: 1, ended: true } } as Record<
      string,
      { lastActivityAt: number; ended: boolean }
    >,
  };
}
let disk = baseline();
let fail = false;
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
  h.archive.mockReset().mockResolvedValue(undefined);
  h.live.clear();
  vi.spyOn(Date, "now").mockReturnValue(now);
  disk = baseline();
  fail = false;
  h.rows = [
    {
      id: "a",
      agentId: "fixture",
      cwd: "/p",
      nativeSessionId: "a",
      title: "A",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      configOptions: null,
    },
  ];
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return structuredClone(disk);
    if (fail) throw new Error("disk full");
    disk = structuredClone(args.value);
  });
});
afterEach(() => vi.restoreAllMocks());
async function load() {
  const d = await import("./drafts");
  const { archiveActivity: activity } = await import("./archive_activity");
  const policy = await import("./auto_archive");
  await d.draftPersistence.load();
  return { d, activity, ...policy };
}

it("retains cold known endings while treating old v1 values without activity as unknown", async () => {
  let scope = await load();
  expect(scope.archiveEligible(h.rows[0], undefined, 7, now)).toBe(true);
  await scope.runAutoArchive();
  expect(h.archive).toHaveBeenCalledExactlyOnceWith("a", true);
  delete (disk as Partial<typeof disk>).activity;
  vi.resetModules();
  h.archive.mockClear();
  scope = await load();
  await scope.runAutoArchive();
  expect(scope.activity.get("a")).toBeUndefined();
  expect(h.archive).not.toHaveBeenCalled();
});

it("continues with an independent conversation after one archive fails", async () => {
  disk.activity.b = { lastActivityAt: 1, ended: true };
  h.rows.push({ ...h.rows[0], id: "b", nativeSessionId: "b", cwd: "/q" });
  h.archive.mockImplementation(async (id) => {
    if (id === "a") throw new Error("directory unavailable");
    h.rows[1] = { ...h.rows[1], archived: true };
  });

  const scope = await load();
  await scope.runAutoArchive();

  expect(h.archive.mock.calls).toEqual([
    ["a", true],
    ["b", true],
  ]);
  expect(h.rows.map(({ archived }) => archived)).toEqual([false, true]);

  h.archive.mockClear();
  await scope.retryAutoArchive();
  expect(h.archive).toHaveBeenCalledExactlyOnceWith("a", true);
});

it("does not persist a cleared draft without its refreshed activity, including failed save and cold restart", async () => {
  disk.composers["session:a"] = { text: "UNSENT", attachments: [] };
  let scope = await load();
  fail = true;
  scope.d.composerDrafts.clear("session:a");
  await expect(scope.activity.flush()).rejects.toThrow();
  expect(scope.activity.get("a")).toBeUndefined();
  expect(disk.composers["session:a"]).toMatchObject({ text: "UNSENT" });
  vi.resetModules();
  fail = false;
  scope = await load();
  expect(scope.d.hasUnsentWork("a")).toBe(true);
  expect(scope.archiveEligible(h.rows[0], undefined, 7, now)).toBe(false);
  scope.d.composerDrafts.clear("session:a");
  await scope.activity.flush();
  expect(disk.composers["session:a"]).toBeUndefined();
  expect(disk.activity.a).toEqual({ lastActivityAt: now, ended: true });
  vi.resetModules();
  scope = await load();
  expect(scope.d.hasUnsentWork("a")).toBe(false);
  expect(scope.archiveEligible(h.rows[0], undefined, 7, now)).toBe(false);
  expect(
    h.invoke.mock.calls.every(([, args]) => args.key === "unsentWork.v1"),
  ).toBe(true);
});

it("protects an edit and clear made while an unrelated save and automatic check are awaiting a receipt", async () => {
  const scope = await load();
  let release!: () => void;
  let first = true;
  h.invoke.mockImplementation(async (_command, args) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    disk = structuredClone(args.value);
  });
  const other = scope.activity.begin("b");
  await vi.waitFor(() => expect(release).toBeDefined());
  const checking = scope.runAutoArchive();
  scope.d.composerDrafts.update("session:a", () => ({
    text: "temporary",
    attachments: [],
  }));
  scope.d.composerDrafts.clear("session:a");
  expect(scope.activity.get("a")).toBeUndefined();
  release();
  await Promise.all([other, checking]);
  await scope.activity.flush();
  expect(h.archive).not.toHaveBeenCalled();
  expect(disk.activity.a).toEqual({ lastActivityAt: now, ended: true });
  expect(disk.composers["session:a"]).toBeUndefined();
});

it("persists a failed key's staged edit in a later successful combined save rather than reviving its old timestamp", async () => {
  const scope = await load();
  fail = true;
  await expect(scope.activity.touch("a")).rejects.toThrow();
  expect(scope.activity.get("a")).toBeUndefined();
  fail = false;
  await scope.activity.begin("b");
  expect(disk.activity.a).toEqual({ lastActivityAt: now, ended: true });
  expect(scope.activity.get("a")).toEqual(disk.activity.a);
  await scope.runAutoArchive();
  expect(h.archive).not.toHaveBeenCalled();
});

it("keeps the later begin authoritative over an earlier ending and a touch never invents an ending", async () => {
  const scope = await load();
  await Promise.all([scope.activity.finish("a"), scope.activity.begin("a")]);
  expect(disk.activity.a).toEqual({ lastActivityAt: now, ended: false });
  await scope.activity.touch("unrecorded");
  expect(disk.activity.unrecorded.ended).toBe(false);
  await scope.activity.touch("a");
  expect(disk.activity.a.ended).toBe(false);
});

it("refuses corrupted activity without overwriting the old input or metadata", async () => {
  disk.activity.a.ended = "bad" as unknown as boolean;
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(
    h.invoke.mock.calls.every(([command]) => command === "settings_get"),
  ).toBe(true);
});
