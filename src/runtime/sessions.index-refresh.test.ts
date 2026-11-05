import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  rows: [] as unknown[],
  fail: false,
  next: null as Promise<unknown[]> | null,
}));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(async (command: string) => {
    if (command === "session_index_list") {
      if (native.fail) throw new Error("controlled read failure");
      if (native.next) {
        const response = native.next;
        native.next = null;
        return response;
      }
      return structuredClone(native.rows);
    }
    if (command === "settings_get") return 0;
    throw new Error(`unexpected ${command}`);
  }),
}));
import { threads, type IndexRow } from "./sessions";

const original: IndexRow = {
  id: "saved",
  agentId: "fixture",
  cwd: "/controlled/project",
  nativeSessionId: "native",
  title: "Saved",
  configOptions: {
    service: { kind: "agent", id: "chosen" },
    options: [{ id: "model", value: "chosen-model" }],
  },
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
};
const current = () => threads.getSnapshot().index[0];
beforeEach(async () => {
  native.fail = false;
  native.next = null;
  native.rows = [];
  await threads.refreshIndex();
  native.rows = [structuredClone(original)];
  await threads.refreshIndex();
});

it("preserves exact row authority across fresh equal JSON IPC responses", async () => {
  const before = current();
  const beforeIndex = threads.getSnapshot().index;
  await threads.refreshIndex();
  expect(current()).toEqual(before);
  expect(current()).toBe(before);
  expect(current()).not.toBe(native.rows[0]);
  expect(threads.getSnapshot().index).toBe(beforeIndex);
});

it("does not treat JSON object key order as a source change", async () => {
  const before = current();
  native.rows = [
    {
      ...original,
      configOptions: {
        options: [{ value: "chosen-model", id: "model" }],
        service: { id: "chosen", kind: "agent" },
      },
    },
  ];
  await threads.refreshIndex();
  expect(current()).toBe(before);
});

it.each([
  { id: "another" },
  { agentId: "another-agent" },
  { cwd: "/controlled/elsewhere" },
  { nativeSessionId: "another-native" },
  { title: "Renamed" },
  {
    configOptions: {
      ...(original.configOptions as object),
      service: { kind: "agent", id: "another" },
    },
  },
  {
    configOptions: {
      ...(original.configOptions as object),
      options: [{ id: "model", value: "another-model" }],
    },
  },
  { pinned: true },
  { archived: true },
  { createdAt: 3 },
  { updatedAt: 4 },
  { futureSourceField: "changed" },
])(
  "retires the prior row for a full-field change and does not revive it on ABA: %j",
  async (change) => {
    const before = current();
    native.rows = [{ ...structuredClone(original), ...change }];
    await threads.refreshIndex();
    const changed = current();
    expect(changed).not.toBe(before);
    expect(changed).toEqual(native.rows[0]);
    native.rows = [structuredClone(original)];
    await threads.refreshIndex();
    expect(current()).toEqual(before);
    expect(current()).not.toBe(before);
    expect(current()).not.toBe(changed);
  },
);

it("does not revive an old row when a removed row is later restored", async () => {
  const before = current();
  native.rows = [];
  await threads.refreshIndex();
  expect(threads.getSnapshot().index).toEqual([]);
  native.rows = [structuredClone(original)];
  await threads.refreshIndex();
  expect(current()).toEqual(before);
  expect(current()).not.toBe(before);
});

it("rereads when an awaited response crosses a real row change, never reviving a prior ABA reference", async () => {
  const before = current();
  let release!: (rows: unknown[]) => void;
  native.next = new Promise((resolve) => {
    release = resolve;
  });
  const late = threads.refreshIndex();
  native.rows = [{ ...original, cwd: "/controlled/changed" }];
  await threads.refreshIndex();
  const changed = current();
  expect(changed).not.toBe(before);
  release([structuredClone(original)]);
  await late;
  expect(current()).toEqual(native.rows[0]);
  expect(current()).toBe(changed);
  expect(current()).not.toBe(before);
});

it("keeps unchanged neighbours across reordering and keeps the last index on IPC failure", async () => {
  const before = current();
  native.rows = [{ ...original, id: "another" }, structuredClone(original)];
  await threads.refreshIndex();
  expect(threads.getSnapshot().index[1]).toBe(before);
  const prior = threads.getSnapshot().index;
  native.fail = true;
  await threads.refreshIndex();
  expect(threads.getSnapshot().index).toBe(prior);
});
