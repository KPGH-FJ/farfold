import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionData } from "./collections";
import type { SidebarRow } from "./sidebar";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./sessions", () => ({ useThreadsSnapshot: vi.fn() }));
const initial: CollectionData = {
  groups: [{ id: "g1", name: "Before" }],
  assignments: { conversation: "g1" },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});
async function setup() {
  invoke.mockImplementation((command: string) =>
    command === "settings_get"
      ? Promise.resolve(structuredClone(initial))
      : Promise.resolve(),
  );
  const module = await import("./collections");
  await module.collections.load();
  return module;
}

describe("conversation collection persistence", () => {
  it("replaces the same filter dimension while preserving independent group and favorite filters", async () => {
    const { libraryDimensions } = await setup();
    expect(
      libraryDimensions({ kind: "agent", id: "one" }, null, "group"),
    ).toEqual({ agent: "one", group: "group", favorites: false });
    expect(
      libraryDimensions({ kind: "agent", id: "one" }, "two", "group"),
    ).toEqual({ agent: "two", group: "group", favorites: false });
    expect(libraryDimensions({ kind: "group", id: "old" }, "two", "")).toEqual({
      agent: "two",
      group: "",
      favorites: false,
    });
    expect(
      libraryDimensions({ kind: "favorites" }, "two", "group").favorites,
    ).toBe(true);
  });
  it("keeps committed groups and assignments until a database write succeeds", async () => {
    const { collections } = await setup();
    const started = deferred<void>();
    const write = deferred<void>();
    invoke.mockImplementation(() => {
      started.resolve();
      return write.promise;
    });
    const updating = collections.rename("g1", "After");
    await started.promise;
    expect(collections.snapshot()).toMatchObject({ ...initial, saving: true });
    write.reject(new Error("database unavailable"));
    await expect(updating).rejects.toThrow();
    expect(collections.snapshot()).toMatchObject({ ...initial, saving: false });
    expect(collections.snapshot().error).toBeTruthy();
  });
  it("does not let a mutating transform corrupt the committed snapshot after write failure", async () => {
    const { collections } = await setup();
    invoke.mockRejectedValue(new Error("database unavailable"));
    await expect(
      collections.update((data) => {
        data.groups[0].name = "Lost original";
        delete data.assignments.conversation;
        return data;
      }),
    ).rejects.toThrow();
    expect(collections.snapshot()).toMatchObject(initial);
  });
  it("rejects blank names without persisting groups that disappear when reloaded", async () => {
    const { collections } = await setup();
    invoke.mockClear();
    await expect(collections.create("  ")).rejects.toThrow();
    await expect(collections.rename("g1", "\n")).rejects.toThrow();
    expect(collections.snapshot()).toMatchObject(initial);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("serializes concurrent edits and derives the next update from the latest committed data", async () => {
    const { collections } = await setup();
    const started = deferred<void>();
    const write = deferred<void>();
    invoke.mockClear();
    invoke
      .mockImplementationOnce(() => {
        started.resolve();
        return write.promise;
      })
      .mockResolvedValue(undefined);
    const renamed = collections.rename("g1", "Renamed");
    const created = collections.create("Another");
    await started.promise;
    expect(invoke).toHaveBeenCalledTimes(1);
    write.resolve();
    await Promise.all([renamed, created]);
    expect(collections.snapshot().groups.map((g) => g.name)).toEqual([
      "Renamed",
      "Another",
    ]);
    expect(collections.snapshot().assignments).toEqual(initial.assignments);
    expect(
      invoke.mock.calls[1][1].value.groups.map((g: { name: string }) => g.name),
    ).toEqual(["Renamed", "Another"]);
  });
  it("continues queued edits from the old snapshot after an earlier write fails", async () => {
    const { collections } = await setup();
    invoke
      .mockRejectedValueOnce(new Error("first write failed"))
      .mockResolvedValue(undefined);
    const renamed = collections.rename("g1", "Unsaved");
    const added = collections.create("Next");
    await expect(renamed).rejects.toThrow();
    await added;
    expect(collections.snapshot().groups.map((g) => g.name)).toEqual([
      "Before",
      "Next",
    ]);
    expect(collections.snapshot().error).toBeNull();
  });
  it("does not replace existing data with empty groups on load failure, and can retry", async () => {
    const { collections } = await import("./collections");
    invoke
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(undefined);
    await expect(collections.load()).rejects.toThrow();
    expect(collections.snapshot().ready).toBe(false);
    await collections.create("Added after retry");
    expect(collections.snapshot().groups.map((g) => g.name)).toEqual([
      "Before",
      "Added after retry",
    ]);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "settings_get",
      "settings_get",
      "settings_set",
    ]);
  });
  it("renames and deletes only grouping metadata, preserving conversation identity and working location", async () => {
    const { collections, matchesLibraryFilter } = await setup();
    const row = {
      key: "conversation",
      title: "Title",
      agentId: "one",
      cwd: "/original/folder",
      nativeSessionId: "native",
      pinned: true,
      archived: false,
      updatedAt: 1,
      status: "need" as const,
      live: false,
      source: "meta" as const,
    };
    const before = structuredClone(row);
    invoke.mockClear();
    await collections.rename("g1", "Renamed");
    expect(
      matchesLibraryFilter(
        row,
        { kind: "group", id: "g1" },
        collections.snapshot(),
      ),
    ).toBe(true);
    await collections.remove("g1");
    expect(collections.snapshot().assignments).toEqual({});
    expect(row).toEqual(before);
    expect(invoke.mock.calls.every((call) => call[0] === "settings_set")).toBe(
      true,
    );
    expect(
      invoke.mock.calls.every(
        (call) => call[1].key === "conversationGroups.v1",
      ),
    ).toBe(true);
  });
});

describe("collection actions and visible selections", () => {
  it("does not close a newer dialog when an earlier save completes, and suppresses duplicate submits", async () => {
    const { CollectionActionScope } = await import("./collections");
    const scope = new CollectionActionScope();
    const write = deferred<void>();
    const pending = vi.fn();
    const closeOldDialog = vi.fn();
    const duplicate = vi.fn();
    const saved = scope.run(() => write.promise, {
      pending,
      success: closeOldDialog,
      failure: vi.fn(),
    });
    scope.invalidate();
    await scope.run(duplicate, { pending, failure: vi.fn() });
    expect(duplicate).not.toHaveBeenCalled();
    write.resolve();
    await saved;
    expect(closeOldDialog).not.toHaveBeenCalled();
    expect(pending.mock.calls).toEqual([[true], [false]]);
    const nextSave = vi.fn().mockResolvedValue(undefined);
    const closeNewDialog = vi.fn();
    await scope.run(nextSave, {
      pending,
      success: closeNewDialog,
      failure: vi.fn(),
    });
    expect(nextSave).toHaveBeenCalledOnce();
    expect(closeNewDialog).toHaveBeenCalledOnce();
  });
  it("does not write an old failure into a reopened dialog and can retry the current failure", async () => {
    const { CollectionActionScope } = await import("./collections");
    const scope = new CollectionActionScope();
    const write = deferred<void>();
    const showError = vi.fn();
    const saved = scope.run(() => write.promise, {
      pending: vi.fn(),
      failure: showError,
    });
    scope.invalidate();
    write.reject(new Error("old operation failed"));
    await saved;
    expect(showError).not.toHaveBeenCalled();
    const reason = new Error("请先处理此对话的任务和未发送内容，再归档");
    await scope.run(() => Promise.reject(reason), {
      pending: vi.fn(),
      failure: showError,
    });
    expect(showError).toHaveBeenCalledExactlyOnceWith(reason);
  });
  it("selects and clears only current results and never sends hidden selections to bulk actions", async () => {
    const { selectedLibraryRows, toggleVisibleSelection } =
      await import("./collections");
    const row = (key: string): SidebarRow => ({
      key,
      title: key,
      agentId: "one",
      cwd: "/folder",
      nativeSessionId: key,
      pinned: false,
      archived: false,
      updatedAt: 0,
      status: "idle",
      live: false,
      source: "meta",
    });
    const visible = [row("visible-a"), row("visible-b")];
    const original = new Set(["hidden", "visible-a"]);
    const selected = toggleVisibleSelection(visible, original);
    expect(
      selectedLibraryRows(visible, selected).map((item) => item.key),
    ).toEqual(["visible-a", "visible-b"]);
    expect(original).toEqual(new Set(["hidden", "visible-a"]));
    expect(toggleVisibleSelection(visible, selected)).toEqual(
      new Set(["hidden"]),
    );
    expect(toggleVisibleSelection([], selected)).toEqual(selected);
  });
  it("filters by collection and Agent independently from conversation working locations", async () => {
    const { matchesLibraryFilter } = await setup();
    const row: SidebarRow = {
      key: "conversation",
      title: "Title",
      agentId: "one",
      cwd: "/unchanged/folder",
      nativeSessionId: "native",
      pinned: true,
      archived: false,
      updatedAt: 0,
      status: "need",
      live: false,
      source: "meta",
    };
    expect(
      matchesLibraryFilter(row, { kind: "group", id: "g1" }, initial),
    ).toBe(true);
    expect(
      matchesLibraryFilter(
        { ...row, cwd: "/another/folder" },
        { kind: "group", id: "g1" },
        initial,
      ),
    ).toBe(true);
    expect(
      matchesLibraryFilter(row, { kind: "agent", id: "two" }, initial),
    ).toBe(false);
    expect(matchesLibraryFilter(row, { kind: "attention" }, initial)).toBe(
      true,
    );
    expect(matchesLibraryFilter(row, { kind: "running" }, initial)).toBe(false);
    expect(matchesLibraryFilter(row, { kind: "favorites" }, initial)).toBe(
      true,
    );
  });
});
