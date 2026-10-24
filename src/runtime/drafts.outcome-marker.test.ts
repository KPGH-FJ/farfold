import { beforeEach, expect, it, vi } from "vitest";
import type { PromptBlock } from "./session_types";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset().mockResolvedValue(null);
});
const input = (text: string): PromptBlock[] => [{ type: "text", text }];
const snapshot = (queue: Record<string, unknown>) => ({
  version: 1,
  composers: {},
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: {},
  queues: { owned: queue },
});

it("round-trips a notice-only record without counting it as unsent input", async () => {
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.draftQueues.write("owned", [], null, true);
  await d.draftPersistence.flush();
  const stored = h.invoke.mock.calls
    .filter(([name]) => name === "settings_set")
    .at(-1)![1].value;
  expect(stored.queues.owned).toEqual({
    blocks: [],
    uncertainIndex: null,
    outcomeUnknown: true,
  });
  expect(d.hasUnsentWork("owned")).toBe(false);
  expect(d.unsentConversationKeys()).toEqual([]);
  vi.resetModules();
  h.invoke.mockImplementation(async (name: string) =>
    name === "settings_get" ? stored : null,
  );
  const restored = await import("./drafts");
  await restored.draftPersistence.load();
  expect(restored.draftQueues.read("owned")).toEqual(stored.queues.owned);
  expect(restored.hasUnsentWork("owned")).toBe(false);
  restored.draftQueues.write("owned", [], null, false);
  await restored.draftPersistence.flush();
  expect(restored.draftQueues.read("owned")).toBeNull();
});

it("keeps legacy queued input and optional false notices compatible", async () => {
  const d = await import("./drafts");
  const queue = { blocks: [input("saved")], uncertainIndex: 0 };
  expect(d.parseDraftSnapshot(snapshot(queue))?.queues[0][1]).toEqual(queue);
  expect(
    d.parseDraftSnapshot(snapshot({ ...queue, outcomeUnknown: false }))
      ?.queues[0][1].outcomeUnknown,
  ).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(["true", 1, null, {}, []].map((value) => ({ value })))(
  "rejects a malformed notice atomically ($value)",
  async ({ value: outcomeUnknown }) => {
    h.invoke.mockResolvedValue(
      snapshot({ blocks: [], uncertainIndex: null, outcomeUnknown }),
    );
    const d = await import("./drafts");
    await expect(d.draftPersistence.load()).rejects.toThrow();
    expect(d.draftQueues.read("owned")).toBeNull();
    await expect(d.draftPersistence.flush()).rejects.toThrow();
    expect(h.invoke.mock.calls.every(([name]) => name === "settings_get")).toBe(
      true,
    );
  },
);

it("recognizes the finite notice field in strict import without counting a pending message", async () => {
  const { previewEntries } = await import("./storage_restore");
  const preview = (outcomeUnknown: unknown) =>
    previewEntries(
      {
        id: "a".repeat(48),
        sourcePath: "/owned-copy",
        values: {
          "unsentWork.v1": JSON.stringify(
            snapshot({ blocks: [], uncertainIndex: null, outcomeUnknown }),
          ),
          "agentSetup.v1": null,
        },
      },
      ["unsentWork.v1"],
    )[0];
  expect(preview(true)).toMatchObject({ valid: true, empty: false });
  const { STORAGE_RESTORE_STRINGS: S } =
    await import("./storage_restore_strings");
  expect(preview(true).summary).toBe(S.draftCount(0, 0, 0));
  expect(preview("true").valid).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});

it("merges a pre-hydration notice without hiding saved queued blocks", async () => {
  let deliver!: (value: unknown) => void;
  h.invoke.mockImplementation((name: string) =>
    name === "settings_get"
      ? new Promise((resolve) => {
          deliver = resolve;
        })
      : Promise.resolve(),
  );
  const d = await import("./drafts");
  const load = d.draftPersistence.load();
  d.draftQueues.write("owned", [], null, true);
  const queued = [input("saved waiting")];
  deliver(snapshot({ blocks: queued, uncertainIndex: 0 }));
  await load;
  expect(d.draftQueues.read("owned")).toEqual({
    blocks: queued,
    uncertainIndex: 0,
    outcomeUnknown: true,
  });
  await d.draftPersistence.flush();
});

it("retains newer pre-hydration queued input and the older saved notice together", async () => {
  let deliver!: (value: unknown) => void;
  h.invoke.mockImplementation((name: string) =>
    name === "settings_get"
      ? new Promise((resolve) => {
          deliver = resolve;
        })
      : Promise.resolve(),
  );
  const d = await import("./drafts");
  const load = d.draftPersistence.load();
  const queued = [input("newer waiting")];
  d.draftQueues.write("owned", queued, 0);
  deliver(
    snapshot({
      blocks: [input("older waiting")],
      uncertainIndex: null,
      outcomeUnknown: true,
    }),
  );
  await load;
  expect(d.draftQueues.read("owned")).toEqual({
    blocks: queued,
    uncertainIndex: 0,
    outcomeUnknown: true,
  });
  await d.draftPersistence.flush();
});
