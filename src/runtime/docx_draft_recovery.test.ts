import { beforeEach, expect, it, vi } from "vitest";
import {
  documentAttachment,
  documentBlock,
  approvedDocument,
} from "./docx_draft.test-support";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
function snapshot() {
  return {
    version: 1,
    composers: {
      new: {
        text: "pending text",
        attachments: [documentAttachment()],
        queueEdit: { index: 0, original: [documentBlock()] },
        pendingConversation: {
          agentId: "chosen",
          cwd: "/owned",
          nativeSessionId: "known",
          service: { id: "selected", model: "kept" },
          serviceRevision: "r1",
        },
        sendPending: true,
      },
    },
    choice: { agentId: "chosen", cwd: "/owned", service: null, config: {} },
    feedback: {},
    queues: { old: { blocks: [[documentBlock()]], uncertainIndex: 0 } },
  };
}

it("durably retains exact approved text and source across cold recovery, pending/new draft, queue edit and unknown queue; sends nothing", async () => {
  let disk = snapshot();
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command === "settings_set") disk = structuredClone(args.value);
    return null;
  });
  const first = await import("./drafts");
  await first.draftPersistence.load();
  const initial = first.composerDrafts.read("new");
  expect(initial).toMatchObject({
    text: "pending text",
    sendPending: true,
    attachments: [{ documentText: approvedDocument(), recovered: true }],
    pendingConversation: { service: { id: "selected", model: "kept" } },
  });
  expect(initial.queueEdit?.original).toEqual([documentBlock()]);
  expect(first.draftQueues.read("old")).toEqual(snapshot().queues.old);
  first.composerDrafts.update("new", (draft) => ({
    ...draft,
    text: "newer pending text",
  }));
  await first.draftPersistence.flush();
  expect(disk.composers.new.attachments[0].documentText).toEqual(
    approvedDocument(),
  );
  expect(disk.composers.new.attachments[0]).not.toHaveProperty("recovered");
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.read("new")).toMatchObject({
    text: "newer pending text",
    attachments: [{ documentText: approvedDocument(), recovered: true }],
    sendPending: true,
  });
  expect(cold.draftQueues.read("old")?.uncertainIndex).toBe(0);
  expect(
    h.invoke.mock.calls.every(([command]) =>
      ["settings_get", "settings_set"].includes(command),
    ),
  ).toBe(true);
});

it.each([
  "schema",
  "bytes",
  "source",
  "image",
  "queue",
  "queueEditor",
  "unconfirmedPartial",
])(
  "rejects malformed %s metadata before publishing any recovered input or overwriting storage",
  async (mutation) => {
    const disk = snapshot();
    if (mutation === "schema")
      (
        disk.composers.new.attachments[0].documentText!.local as unknown as {
          schema: number;
        }
      ).schema = 2;
    if (mutation === "bytes")
      disk.composers.new.attachments[0].documentText!.local!.utf8Bytes++;
    if (mutation === "source")
      (
        disk.composers.new.attachments[0].documentText!.local!
          .source as unknown as { root: unknown }
      ).root = 23;
    if (mutation === "image") disk.composers.new.attachments[0].kind = "image";
    if (mutation === "unconfirmedPartial")
      disk.composers.new.attachments[0].documentText!.local!.partial = true;
    if (mutation === "queue")
      (
        disk.queues.old.blocks[0][0].localDocumentText as unknown as {
          format: string;
        }
      ).format = "unknown";
    if (mutation === "queueEditor")
      (
        disk.composers.new.queueEdit.original[0]
          .localDocumentText as unknown as { partial: unknown }
      ).partial = "true";
    const before = structuredClone(disk);
    h.invoke.mockResolvedValue(disk);
    const drafts = await import("./drafts");
    await expect(drafts.draftPersistence.load()).rejects.toThrow();
    expect(drafts.draftPersistence.snapshot().ready).toBe(false);
    expect(drafts.composerDrafts.read("new").text).toBe("");
    expect(drafts.draftQueues.read("old")).toBeNull();
    drafts.composerDrafts.update("new", () => ({
      text: "new local typing",
      attachments: [],
    }));
    await expect(drafts.draftPersistence.flush()).rejects.toThrow();
    expect(disk).toEqual(before);
    expect(
      h.invoke.mock.calls.every(([command]) => command === "settings_get"),
    ).toBe(true);
  },
);

it("preserves unknown-source official text over the conversion limit while keeping it unapproved and recovered", async () => {
  const disk = snapshot();
  const retained = "H".repeat(256 * 1024 + 1);
  disk.composers.new.attachments[0].documentText = {
    text: retained,
    local: null,
  };
  h.invoke.mockResolvedValue(disk);
  const drafts = await import("./drafts");
  await drafts.draftPersistence.load();
  expect(drafts.composerDrafts.read("new").attachments[0]).toMatchObject({
    documentText: { text: retained, local: null },
    recovered: true,
  });
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("settings_get", {
    key: "unsentWork.v1",
  });
});
