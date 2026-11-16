import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitOpeningHeader } from "./session_open_test_fixture";

const native = vi.hoisted(() => ({
  rows: [] as unknown[],
  next: null as Promise<unknown[]> | null,
  fail: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(async (command: string, args) => {
    if (command === "session_index_list") {
      if (native.next) {
        const response = native.next;
        native.next = null;
        return response;
      }
      if (native.fail) throw new Error("controlled index read failure");
      return structuredClone(native.rows);
    }
    if (command === "settings_get")
      return args.key === "autoArchiveDays" ? 0 : null;
    if (command === "settings_set") return null;
    if (command === "session_open") {
      const opened = {
        ...row,
        id: `fixture:${row.cwd}:opened`,
        nativeSessionId: "opened",
        title: "Initially opened title",
        archived: false,
      };
      native.rows.push(opened);
      const result = {
        cwd: row.cwd,
        nativeSessionId: "opened",
        connectionId: "controlled-open-connection",
        resumed: false,
        configOptions: [],
        permissionState: "ready",
        configCheck: { status: "ready", issues: [], current: { choices: [] } },
        warnings: [],
      };
      emitOpeningHeader(args, result);
      return result;
    }
    if (command === "session_close" || command === "session_touch") return null;
    if (command === "session_meta_archive") {
      native.rows = native.rows.map((value) => {
        const row = value as IndexRow;
        return row.id === args.sessionId
          ? { ...row, archived: args.archived, updatedAt: 3 }
          : row;
      });
      return null;
    }
    if (command === "session_meta_rename") {
      native.rows = native.rows.map((value) => {
        const row = value as IndexRow;
        return row.id === args.sessionId
          ? { ...row, title: args.title, updatedAt: 3 }
          : row;
      });
      return structuredClone(
        native.rows.find((value) => (value as IndexRow).id === args.sessionId),
      );
    }
    throw new Error(`unexpected ${command}`);
  }),
}));
import { invoke } from "@tauri-apps/api/core";
import { threads, type IndexRow } from "./sessions";
import { groupSidebarRows } from "./sidebar";
import { refreshIndexRows } from "./session_index_refresh";

const row: IndexRow = {
  id: "archive-ordering-fixture",
  agentId: "fixture",
  cwd: "/controlled/archive-ordering",
  nativeSessionId: "native",
  title: "Original controlled title",
  configOptions: null,
  pinned: false,
  archived: true,
  createdAt: 1,
  updatedAt: 2,
};

function delayRead() {
  let resolve!: (rows: unknown[]) => void;
  let reject!: (error: Error) => void;
  native.next = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject };
}
const index = () => threads.getSnapshot().index;
const visible = () =>
  groupSidebarRows(index(), new Map()).flatMap((group) => group.rows);
const openedKeys: string[] = [];

beforeEach(async () => {
  native.next = null;
  native.fail = false;
  native.rows = [structuredClone(row)];
  await threads.refreshIndex();
  vi.mocked(invoke).mockClear();
});
afterEach(async () => {
  for (const key of openedKeys.splice(0)) await threads.close(key);
});

it("does not let an older index read hide a conversation after its actual restore finishes", async () => {
  const gate = delayRead();
  const olderRefresh = threads.refreshIndex();

  await threads.setArchived(row.id, false);
  const restored = index()[0];
  expect(restored.archived).toBe(false);
  expect(visible().map((item) => item.key)).toEqual([row.id]);

  gate.resolve([structuredClone(row)]);
  await olderRefresh;

  expect(index()[0].archived).toBe(false);
  expect(visible().map((item) => item.key)).toEqual([row.id]);
  expect(index()[0]).toBe(restored);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "session_meta_archive"),
  ).toEqual([["session_meta_archive", { sessionId: row.id, archived: false }]]);
  expect(native.rows).toEqual([{ ...row, archived: false, updatedAt: 3 }]);
});

it("does not let an older index read undo a confirmed rename and its refreshed row", async () => {
  const gate = delayRead();
  const olderRefresh = threads.refreshIndex();

  await threads.rename(row.id, "Confirmed controlled title");
  const renamed = index()[0];
  gate.resolve([structuredClone(row)]);
  await olderRefresh;

  expect(index()[0].title).toBe("Confirmed controlled title");
  expect(index()[0]).toBe(renamed);
  expect(native.rows).toEqual([
    { ...row, title: "Confirmed controlled title", updatedAt: 3 },
  ]);
});

it("rereads after a conflicting publication and retains legitimate new local rows", async () => {
  native.rows = [];
  await threads.refreshIndex();
  const gate = delayRead();
  const olderRefresh = threads.refreshIndex();
  native.rows = [{ ...row, archived: false }];
  await threads.refreshIndex();
  const first = index()[0];
  // A further local save can be present when the older IPC finally returns.
  native.rows.push({ ...row, id: "newly-saved", archived: false });

  gate.resolve([]);
  await olderRefresh;

  expect(index().map((item) => item.id)).toEqual([row.id, "newly-saved"]);
  expect(index()[0]).toBe(first);
});

it("keeps the newer known index if the required fresh read fails", async () => {
  const gate = delayRead();
  const olderRefresh = threads.refreshIndex();
  native.rows = [{ ...row, archived: false }];
  await threads.refreshIndex();
  const known = index();
  native.fail = true;

  gate.resolve([structuredClone(row)]);
  await olderRefresh;

  expect(visible().map((item) => item.key)).toEqual([row.id]);
  expect(index()).toBe(known);
});

it("keeps the newer known index when the older request itself fails", async () => {
  const gate = delayRead();
  const olderRefresh = threads.refreshIndex();
  native.rows = [{ ...row, archived: false }];
  await threads.refreshIndex();
  const known = index();

  gate.reject(new Error("controlled older read failure"));
  await olderRefresh;

  expect(index()).toBe(known);
  expect(visible().map((item) => item.key)).toEqual([row.id]);
});

it("does not let the actual open path overwrite a rename confirmed during its index read", async () => {
  const gate = delayRead();
  const opening = threads.open({
    agentId: row.agentId,
    cwd: row.cwd,
    fresh: true,
  });
  const key = `fixture:${row.cwd}:opened`;
  openedKeys.push(key);
  await vi.waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "session_index_list"),
    ).toHaveLength(1),
  );
  const beforeRename = structuredClone(native.rows);
  await threads.rename(key, "Renamed while opening");

  gate.resolve(beforeRename);
  const state = await opening;

  expect(state.title).toBe("Renamed while opening");
  expect(index().find((item) => item.id === key)?.title).toBe(
    "Renamed while opening",
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "session_open"),
  ).toHaveLength(1);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "session_prompt"),
  ).toBe(false);
});

it("keeps the current index after two conflicting reads without an unbounded reread loop", async () => {
  const first = [structuredClone(row)];
  const second = [{ ...row, archived: false }];
  const third = [{ ...row, archived: false, title: "Third confirmed title" }];
  let current = first;
  const read = vi.fn(async () => {
    if (current === first) {
      current = second;
      return first;
    }
    current = third;
    return second;
  });
  const publish = vi.fn((rows: IndexRow[]) => {
    current = rows;
  });

  await refreshIndexRows(read, () => current, publish);

  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).not.toHaveBeenCalled();
  expect(current).toBe(third);
});

it("accepts a response across an equal IPC refresh without needless rereads or lost row authority", async () => {
  const original = structuredClone(row);
  let current = [original];
  const publish = (rows: IndexRow[]) => {
    current = rows;
  };
  const read = vi.fn(async () => {
    await refreshIndexRows(
      async () => [structuredClone(row)],
      () => current,
      publish,
    );
    return [structuredClone(row)];
  });

  await refreshIndexRows(read, () => current, publish);

  expect(read).toHaveBeenCalledTimes(1);
  expect(current[0]).toBe(original);
});

it.each([false, true])(
  "does not resurrect a removed member after index membership ABA (stable neighbour=%s)",
  async (withNeighbour) => {
    const neighbour = { ...row, id: "stable-neighbour", archived: false };
    native.rows = withNeighbour ? [neighbour] : [];
    await threads.refreshIndex();
    const initial = index();
    const gate = delayRead();
    const olderRefresh = threads.refreshIndex();

    const removed = { ...row, id: "removed-after-read-start", archived: false };
    native.rows = [...native.rows, removed];
    await threads.refreshIndex();
    const capturedWhilePresent = structuredClone(native.rows);
    native.rows = withNeighbour ? [neighbour] : [];
    await threads.refreshIndex();
    expect(index().map((item) => item.id)).toEqual(
      withNeighbour ? [neighbour.id] : [],
    );
    if (withNeighbour) expect(index()[0]).toBe(initial[0]);

    gate.resolve(capturedWhilePresent);
    await olderRefresh;

    expect(index().map((item) => item.id)).toEqual(
      withNeighbour ? [neighbour.id] : [],
    );
    if (withNeighbour) expect(index()[0]).toBe(initial[0]);
    expect(native.rows).toEqual(withNeighbour ? [neighbour] : []);
  },
);
