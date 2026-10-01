import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY } from "./library_strings";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./sessions", () => ({ useThreadsSnapshot: vi.fn() }));

const valid = {
  groups: [{ id: "g1", name: "Original" }],
  assignments: { conversation: "g1" },
};

beforeEach(() => {
  vi.resetModules();
  invoke.mockReset();
});

const invalidRecords: [string, unknown][] = [
  ["string root", "unknown format"],
  ["false root", false],
  ["number root", 0],
  ["array root", []],
  ["empty root", {}],
  ["missing groups", { assignments: {} }],
  ["missing assignments", { groups: [] }],
  ["unknown root field", { ...valid, future: "fixture-canary" }],
  ["unrecognized version", { ...valid, version: 2 }],
  ["non-array groups", { groups: {}, assignments: {} }],
  ["null group", { groups: [valid.groups[0], null], assignments: {} }],
  [
    "non-string group id",
    { groups: [{ id: 1, name: "Name" }], assignments: {} },
  ],
  ["blank group id", { groups: [{ id: "  ", name: "Name" }], assignments: {} }],
  ["empty group id", { groups: [{ id: "", name: "Name" }], assignments: {} }],
  ["blank group name", { groups: [{ id: "g1", name: "  " }], assignments: {} }],
  [
    "non-string group name",
    { groups: [{ id: "g1", name: 7 }], assignments: {} },
  ],
  [
    "duplicate group id",
    { groups: [valid.groups[0], valid.groups[0]], assignments: {} },
  ],
  [
    "unknown group field",
    { groups: [{ ...valid.groups[0], future: true }], assignments: {} },
  ],
  ["array assignments", { groups: [], assignments: [] }],
  ["null assignments", { groups: [], assignments: null }],
  [
    "non-string assignment",
    { groups: valid.groups, assignments: { conversation: 3 } },
  ],
  [
    "orphan assignment",
    { groups: valid.groups, assignments: { conversation: "missing" } },
  ],
];

describe("preserving unreadable collection records", () => {
  it.each(invalidRecords)(
    "rejects the complete %s record before any update can replace it",
    async (_name, input) => {
      let stored = structuredClone(input);
      const original = structuredClone(stored);
      invoke.mockImplementation(async (command, request) => {
        if (command === "settings_get") return structuredClone(stored);
        if (command === "settings_set") stored = structuredClone(request.value);
      });
      const { collections } = await import("./collections");
      const loading = await Promise.allSettled([collections.load()]);
      const updates = await Promise.allSettled([
        collections.create("New group"),
        collections.rename("g1", "Renamed"),
        collections.remove("g1"),
        collections.assign(["conversation"], "g1"),
      ]);

      expect(
        invoke.mock.calls.filter(([command]) => command === "settings_set"),
      ).toEqual([]);
      expect(stored).toEqual(original);
      expect(loading[0].status).toBe("rejected");
      expect(updates.map((result) => result.status)).toEqual(
        Array(4).fill("rejected"),
      );
      expect(collections.snapshot()).toMatchObject({
        groups: [],
        assignments: {},
        ready: false,
        saving: false,
        error: LIBRARY.loadError,
      });
      expect(collections.snapshot().error).not.toContain("fixture-canary");
    },
  );

  it("keeps concurrent edits blocked while the unreadable initial read is pending", async () => {
    let resolve!: (value: unknown) => void;
    const read = new Promise((yes) => {
      resolve = yes;
    });
    invoke.mockImplementation(async (command) =>
      command === "settings_get" ? read : undefined,
    );
    const { collections } = await import("./collections");
    const outcomes = Promise.allSettled([
      collections.create("One"),
      collections.create("Two"),
    ]);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("settings_get", {
        key: "conversationGroups.v1",
      }),
    );
    resolve({ ...valid, assignments: { conversation: "lost-group" } });
    expect((await outcomes).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(
      invoke.mock.calls.some(([command]) => command === "settings_set"),
    ).toBe(false);
    expect(collections.snapshot().ready).toBe(false);
  });

  it("retries corrected storage and only then permits preserving its complete grouping", async () => {
    let stored: unknown = {
      ...valid,
      groups: [...valid.groups, { id: "bad", name: "" }],
    };
    invoke.mockImplementation(async (command, request) => {
      if (command === "settings_get") return structuredClone(stored);
      stored = structuredClone(request.value);
    });
    const { collections } = await import("./collections");
    await expect(collections.load()).rejects.toThrow(LIBRARY.loadError);
    expect(
      invoke.mock.calls.some(([command]) => command === "settings_set"),
    ).toBe(false);
    stored = structuredClone(valid);
    await collections.load();
    expect(collections.snapshot()).toMatchObject({
      ...valid,
      ready: true,
      error: null,
    });
    await collections.rename("g1", "  Reviewed  ");
    expect(stored).toEqual({
      groups: [{ id: "g1", name: "Reviewed" }],
      assignments: valid.assignments,
    });
    expect(
      invoke.mock.calls.filter(([command]) => command === "settings_set"),
    ).toHaveLength(1);
  });

  it.each([null, undefined])(
    "treats unsaved %s storage as a valid empty collection",
    async (stored) => {
      invoke.mockImplementation(async (command) =>
        command === "settings_get" ? stored : undefined,
      );
      const { collections } = await import("./collections");
      await collections.load();
      expect(collections.snapshot()).toMatchObject({
        groups: [],
        assignments: {},
        ready: true,
        error: null,
      });
      await collections.create("  First  ");
      expect(collections.snapshot().groups).toMatchObject([{ name: "First" }]);
      expect(
        invoke.mock.calls.filter(([command]) => command === "settings_set"),
      ).toHaveLength(1);
    },
  );

  it("preserves the existing unversioned format and opaque identities while trimming names", async () => {
    const { parseCollections } = await import("./collections");
    const input = {
      groups: [{ id: " original-id ", name: "  Display name  " }],
      assignments: { " agent:/original folder:native-id ": " original-id " },
    };
    expect(parseCollections(input)).toEqual({
      ...input,
      groups: [{ id: " original-id ", name: "Display name" }],
    });
    expect(input.groups[0].name).toBe("  Display name  ");
    expect(parseCollections({ groups: [], assignments: {} })).toEqual({
      groups: [],
      assignments: {},
    });
  });

  it("preserves valid assignment keys that match object prototype names", async () => {
    const { parseCollections } = await import("./collections");
    const input = JSON.parse(
      '{"groups":[{"id":"g1","name":"Original"}],"assignments":{"__proto__":"g1","constructor":"g1"}}',
    );
    const parsed = parseCollections(input);
    expect(Object.keys(parsed.assignments)).toEqual([
      "__proto__",
      "constructor",
    ]);
    expect(Object.hasOwn(parsed.assignments, "__proto__")).toBe(true);
    expect(parsed.assignments.__proto__).toBe("g1");
    expect(Object.getPrototypeOf(parsed.assignments)).toBe(Object.prototype);
  });
});
