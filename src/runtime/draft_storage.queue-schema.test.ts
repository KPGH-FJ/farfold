import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_value: unknown) => {};
  },
}));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});

function snapshot(queue: Record<string, unknown>) {
  return {
    version: 1,
    composers: {
      "session:previous": { text: "previous unsent draft", attachments: [] },
    },
    choice: { agentId: null, cwd: null, service: null, config: {} },
    feedback: {},
    queues: { owned: queue },
  };
}

it.each([
  {
    name: "queued input",
    queue: {
      blocks: [[{ type: "text", text: "known queued input" }]],
      uncertainIndex: 0,
    },
  },
  {
    name: "notice-only record",
    queue: { blocks: [], uncertainIndex: null, outcomeUnknown: true },
  },
])(
  "keeps an unknown $name field intact when failed-history restoration would rewrite the queue",
  async ({ queue }) => {
    let disk = snapshot({
      ...queue,
      futureInput: { text: "unknown input must remain saved" },
    });
    const original = structuredClone(disk);
    h.invoke.mockImplementation(async (command, args) => {
      if (command === "settings_get") return structuredClone(disk);
      if (command === "settings_set") disk = structuredClone(args.value);
      return null;
    });
    const d = await import("./drafts");
    const read = await Promise.allSettled([d.draftPersistence.load()]);
    const { threads } = await import("./sessions");
    // The real failed-open path restores a saved queue and emits its state.
    // Neither this fixture nor the production method starts an Agent request.
    threads.markOpenFailed(
      "owned",
      "fixture-agent",
      "/fixture",
      "native",
      "fixture failure",
    );
    d.composerDrafts.update("new", () => ({
      text: "later local draft",
      attachments: [],
    }));
    const save = await Promise.allSettled([d.draftPersistence.flush()]);
    expect(disk).toEqual(original);
    expect(read[0].status).toBe("rejected");
    expect(save[0].status).toBe("rejected");
    expect(d.draftPersistence.snapshot().ready).toBe(false);
    expect(d.composerDrafts.read("session:previous").text).toBe("");
    expect(d.composerDrafts.read("new").text).toBe("later local draft");
    expect(d.draftQueues.read("owned")).toBeNull();
    expect(h.invoke.mock.calls.every(([name]) => name === "settings_get")).toBe(
      true,
    );
  },
);

it("restores supported queued input without dropping opaque official message metadata", async () => {
  const queue = {
    blocks: [
      [
        {
          type: "text",
          text: "known queued input",
          _meta: { "official.future": { retained: true } },
        },
      ],
    ],
    uncertainIndex: 0,
    outcomeUnknown: true,
  };
  let disk = snapshot(queue);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command === "settings_set") disk = structuredClone(args.value);
    return null;
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const { threads } = await import("./sessions");
  const thread = threads.markOpenFailed(
    "owned",
    "fixture-agent",
    "/fixture",
    "native",
    "fixture failure",
  );
  await d.draftPersistence.flush();
  expect(disk.queues.owned).toEqual(queue);
  expect(thread.queued).toEqual(queue.blocks);
  expect(thread.uncertainPrompt).toBe(thread.queued[0]);
  expect(thread.queuePaused).toBe("uncertain");
  expect(thread.historicalOutcomeUnknown).toBe(true);
  expect(
    h.invoke.mock.calls.every(([name]) =>
      ["settings_get", "settings_set"].includes(name),
    ),
  ).toBe(true);
});
