import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const candidate = () => ({
  version: 1,
  composers: {
    new: { text: "restored input", attachments: [], sendPending: true },
  },
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: {},
  queues: {
    thread: { blocks: [[{ type: "text", text: "queued" }]], uncertainIndex: 0 },
  },
  activity: { thread: { lastActivityAt: 123, ended: false } },
});
it("validates a candidate without hydrating drafts, activity or causing IO", async () => {
  const d = await import("./drafts");
  const { archiveActivity } = await import("./archive_activity");
  const before = d.composerDrafts.read("new");
  const parsed = d.parseDraftSnapshot(candidate());
  expect(parsed?.composers[0][1].sendPending).toBe(true);
  expect(parsed?.queues[0][1].uncertainIndex).toBe(0);
  expect(d.composerDrafts.read("new")).toBe(before);
  expect(archiveActivity.snapshot()).toEqual({});
  expect(h.invoke).not.toHaveBeenCalled();
});
it("validates preparation content without publishing completed setup or selected service", async () => {
  const s = await import("./setup_storage");
  const before = s.setupStorage.snapshot();
  const parsed = s.parseSetupSnapshot({
    version: 1,
    completed: ["agent"],
    pending: {},
    progress: {},
    selections: { agent: { config: { model: "chosen" }, service: null } },
  });
  expect(parsed.completed).toEqual(["agent"]);
  expect(s.setupStorage.snapshot()).toBe(before);
  expect(s.setupStorage.completed("agent")).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});
it.each([
  (v: ReturnType<typeof candidate>) => ({ ...v, version: 99 }),
  (v: ReturnType<typeof candidate>) => ({ ...v, autoSend: true }),
  (v: ReturnType<typeof candidate>) => ({
    ...v,
    composers: { new: { ...v.composers.new, requestAttempted: true } },
  }),
  (v: ReturnType<typeof candidate>) => ({
    ...v,
    queues: { thread: { ...v.queues.thread, paused: false } },
  }),
  (v: ReturnType<typeof candidate>) => ({
    ...v,
    choice: { ...v.choice, autoSend: true },
  }),
])("does not guess unknown versions or pending-send fields", async (change) => {
  const { previewEntries } = await import("./storage_restore");
  const result = previewEntries(
    {
      id: "a".repeat(48),
      sourcePath: "/copy",
      values: {
        "unsentWork.v1": JSON.stringify(change(candidate())),
        "agentSetup.v1": null,
      },
    },
    ["unsentWork.v1"],
  );
  expect(result[0].valid).toBe(false);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("preserves pending flags and attachments in a valid preview without sending", async () => {
  const { previewEntries } = await import("./storage_restore");
  const { parseDraftSnapshot } = await import("./drafts");
  const value = candidate();
  value.composers.new.attachments = [
    {
      id: "one",
      name: "saved.png",
      kind: "image",
      data: "dGVzdA==",
      mimeType: "image/png",
    },
  ] as never[];
  const result = previewEntries(
    {
      id: "a".repeat(48),
      sourcePath: "/copy",
      values: { "unsentWork.v1": JSON.stringify(value), "agentSetup.v1": null },
    },
    ["unsentWork.v1"],
  );
  expect(result[0].valid).toBe(true);
  const parsed = parseDraftSnapshot(value);
  expect(parsed?.composers[0][1].attachments[0].recovered).toBe(true);
  expect(parsed?.composers[0][1].sendPending).toBe(true);
  expect(parsed?.queues[0][1].uncertainIndex).toBe(0);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("distinguishes missing records from explicit empty content", async () => {
  const { previewEntries } = await import("./storage_restore");
  expect(
    previewEntries(
      {
        id: "a".repeat(48),
        sourcePath: "/copy",
        values: { "unsentWork.v1": null, "agentSetup.v1": "null" },
      },
      ["unsentWork.v1", "agentSetup.v1"],
    ).map((v) => ({ valid: v.valid, empty: v.empty })),
  ).toEqual([
    { valid: false, empty: false },
    { valid: true, empty: true },
  ]);
  expect(h.invoke).not.toHaveBeenCalled();
});
it("reads the shared backend recovery fixture after reload without dispatch or automatic writes", async () => {
  const { readFileSync } = await import("node:fs");
  const records = JSON.parse(
    readFileSync(
      new URL("./fixtures/storage-restore-v1.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const { previewEntries } = await import("./storage_restore");
  const values = {
    "unsentWork.v1": JSON.stringify(records["unsentWork.v1"]),
    "agentSetup.v1": JSON.stringify(records["agentSetup.v1"]),
  };
  expect(
    previewEntries({ id: "a".repeat(48), sourcePath: "/fixture", values }, [
      "unsentWork.v1",
      "agentSetup.v1",
    ]).every((v) => v.valid),
  ).toBe(true);
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return records[args.key];
    throw new Error("unexpected write or dispatch");
  });
  const d = await import("./drafts");
  const s = await import("./setup_storage");
  await Promise.all([d.draftPersistence.load(), s.setupStorage.load()]);
  expect(d.composerDrafts.read("new").text).toBe("Fixture recovered input");
  expect(d.composerDrafts.read("new").sendPending).toBe(true);
  expect(d.composerDrafts.read("new").attachments[0].recovered).toBe(true);
  expect(d.draftQueues.read("fixture-thread")?.uncertainIndex).toBe(0);
  expect(s.setupStorage.confirmedSelection("fixture-agent")?.config.model).toBe(
    "fixture-model",
  );
  expect(h.invoke.mock.calls.map((c) => c[0])).toEqual([
    "settings_get",
    "settings_get",
  ]);
});

it("includes an unsaved template edit in recovery preview without loading it", async () => {
  const { previewEntries } = await import("./storage_restore");
  const value = {
    ...candidate(),
    composers: {},
    queues: {},
    templateEdits: {
      id: "unfinished",
      label: "draft title",
      text: "unsaved template",
    },
  };
  const result = previewEntries(
    {
      id: "a".repeat(48),
      sourcePath: "/copy",
      values: { "unsentWork.v1": JSON.stringify(value), "agentSetup.v1": null },
    },
    ["unsentWork.v1"],
  );
  expect(result[0].valid).toBe(true);
  expect(result[0].summary).toContain("1 份模板编辑稿");
  expect(h.invoke).not.toHaveBeenCalled();
});
