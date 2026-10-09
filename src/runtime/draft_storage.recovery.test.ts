import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset();
});

const original = (draft: Record<string, unknown>) => ({
  version: 1,
  composers: {
    "session:previous": { text: "keep previous", attachments: [] },
    new: { text: "keep input", attachments: [], ...draft },
  },
  choice: { agentId: "a", cwd: "/work", service: null, config: {} },
  feedback: {},
  queues: {},
});

it("rejects an attachment kind that only stringifies to a supported kind", async () => {
  mock.invoke.mockResolvedValue(
    original({
      attachments: [
        {
          id: "file",
          name: "notes.md",
          kind: ["file"],
          uri: "file:///notes.md",
        },
      ],
    }),
  );
  const d = await import("./drafts");
  await expect(d.draftPersistence.load()).rejects.toThrow();
  expect(d.draftPersistence.snapshot().ready).toBe(false);
  expect(d.composerDrafts.read("session:previous").text).toBe("");
  expect(mock.invoke.mock.calls.map(([name]) => name)).toEqual([
    "settings_get",
  ]);
});

it.each(["unknown", 1, null])(
  "does not turn an unreadable pending-send marker %j into confirmed editable input",
  async (sendPending) => {
    const disk = original({ sendPending });
    mock.invoke.mockImplementation(async (command) => {
      if (command === "settings_get") return structuredClone(disk);
    });
    const d = await import("./drafts");
    await expect(d.draftPersistence.load()).rejects.toThrow();
    expect(d.draftPersistence.snapshot().ready).toBe(false);
    expect(d.composerDrafts.read("session:previous").text).toBe("");
    d.composerDrafts.update("new", () => ({
      text: "later local input",
      attachments: [],
    }));
    await expect(d.draftPersistence.flush()).rejects.toThrow();
    expect(
      mock.invoke.mock.calls.every(([name]) => name === "settings_get"),
    ).toBe(true);
  },
);

it.each(["uri", "data", "mimeType"])(
  "preserves unreadable saved attachment %s instead of discarding it during recovery",
  async (field) => {
    let disk = original({
      attachments: [
        { id: "image", name: "image.png", kind: "image", [field]: 123 },
      ],
    });
    const captured = structuredClone(disk);
    mock.invoke.mockImplementation(async (command, input) => {
      if (command === "settings_get") return structuredClone(disk);
      if (command === "settings_set") disk = structuredClone(input.value);
    });
    const d = await import("./drafts");
    await expect(d.draftPersistence.load()).rejects.toThrow();
    expect(d.draftPersistence.snapshot().ready).toBe(false);
    expect(d.composerDrafts.read("session:previous").text).toBe("");
    d.composerDrafts.update("new", () => ({ text: "local", attachments: [] }));
    await expect(d.draftPersistence.flush()).rejects.toThrow();
    expect(disk).toEqual(captured);
    expect(
      mock.invoke.mock.calls.every(([name]) => name === "settings_get"),
    ).toBe(true);
  },
);

it("restores legacy omitted optional fields and valid pending input without dispatching", async () => {
  mock.invoke.mockResolvedValue(
    original({
      sendPending: true,
      attachments: [
        { id: "file", name: "notes.md", kind: "file", uri: "file:///notes.md" },
        {
          id: "image",
          name: "image.png",
          kind: "image",
          data: "kept",
          mimeType: "image/png",
        },
      ],
    }),
  );
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.composerDrafts.read("new")).toMatchObject({
    text: "keep input",
    sendPending: true,
    attachments: [
      { uri: "file:///notes.md" },
      { data: "kept", mimeType: "image/png" },
    ],
  });
  expect(d.composerDrafts.read("session:previous").sendPending).toBe(false);
  expect(mock.invoke.mock.calls.map(([name]) => name)).toEqual([
    "settings_get",
  ]);
});
