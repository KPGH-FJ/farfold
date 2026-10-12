import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset().mockResolvedValue(null);
});
async function fixture(key = "document-target") {
  const { composerDrafts, newConversationChoice } = await import("./drafts");
  const { draftPersistence } = await import("./draft_storage");
  const { createDocumentInputTarget } = await import("./document_input_draft");
  await draftPersistence.load();
  composerDrafts.update(key, () => ({
    text: "Keep this input",
    attachments: [
      {
        id: "doc",
        kind: "file",
        name: "fixture.docx",
        uri: "file:///docs/fixture.docx",
      },
    ],
  }));
  const chip = composerDrafts.read(key).attachments[0];
  const approved = {
    text: "Reviewed body",
    local: {
      schema: 1 as const,
      format: "docx" as const,
      source: {
        root: "/docs",
        path: "/docs/fixture.docx",
        resolvedPath: "/docs/fixture.docx",
        name: "fixture.docx",
        size: 1024,
        sha256: "a".repeat(64),
        version: "version",
      },
      textSha256: "b".repeat(64),
      utf8Bytes: 13,
      selection: "read-visible-text" as const,
      partial: false,
      partialSelected: false,
      warnings: [],
      imageReferences: 0,
    },
  };
  const target = createDocumentInputTarget(key, chip, () => true);
  return {
    composerDrafts,
    newConversationChoice,
    draftPersistence,
    target,
    approved,
    key,
  };
}
it("confirms into the exact existing draft once and preserves memory if saving fails", async () => {
  const {
    composerDrafts: d,
    draftPersistence: save,
    target,
    approved,
    key,
  } = await fixture();
  expect(d.read(key).attachments[0].loading).toBe(true);
  h.invoke.mockRejectedValue(new Error("disk unavailable"));
  expect(target.apply(approved)).toBe(true);
  expect(target.apply(approved)).toBe(false);
  await expect(save.flush()).rejects.toThrow();
  expect(d.read(key).text).toBe("Keep this input");
  expect(d.read(key).attachments[0]).toMatchObject({
    documentText: approved,
    loading: false,
    recovered: false,
  });
  expect(save.snapshot().error).not.toBeNull();
  expect(
    h.invoke.mock.calls.every(
      ([name]) => name === "settings_get" || name === "settings_set",
    ),
  ).toBe(true);
});
it("a remove and readd with identical id/path revokes the old read before its result", async () => {
  const { composerDrafts: d, target, approved, key } = await fixture();
  d.update(key, (draft) => ({ ...draft, attachments: [] }));
  d.update(key, (draft) => ({
    ...draft,
    attachments: [
      {
        id: "doc",
        kind: "file",
        name: "fixture.docx",
        uri: "file:///docs/fixture.docx",
        loading: true,
      },
    ],
  }));
  expect(target.signal.aborted).toBe(true);
  expect(target.apply(approved)).toBe(false);
  target.retire();
  expect(d.read(key).attachments[0].loading).toBe(true);
  expect(d.read(key).attachments[0].documentText).toBeUndefined();
});
it("new conversation selection A to B to A synchronously revokes the original read", async () => {
  const {
    composerDrafts: d,
    newConversationChoice: choice,
    target,
    approved,
    key,
  } = await fixture("new");
  choice.agentId = "another-agent";
  choice.agentId = null;
  expect(target.signal.aborted).toBe(true);
  expect(target.apply(approved)).toBe(false);
  expect(d.read(key).attachments[0].loading).toBe(false);
  expect(d.read(key).text).toBe("Keep this input");
});
it("storage/quit lock revokes a pending selection without erasing text or authorizing another URI", async () => {
  const {
    composerDrafts: d,
    draftPersistence: save,
    target,
    approved,
    key,
  } = await fixture();
  const changed = {
    ...approved,
    local: {
      ...approved.local,
      source: { ...approved.local.source, path: "/docs/other.docx" },
    },
  };
  expect(target.apply(changed)).toBe(false);
  expect(target.apply({ text: "Old official text", local: null })).toBe(false);
  save.lockInteraction(true);
  expect(target.signal.aborted).toBe(true);
  expect(target.apply(approved)).toBe(false);
  expect(d.read(key).attachments[0].loading).toBe(false);
  expect(d.read(key).text).toBe("Keep this input");
});
