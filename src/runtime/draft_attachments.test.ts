import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import { prepareDraftAttachments } from "./draft_attachments";
import type { DraftAttachment } from "./drafts";
import { DRAFT_STRINGS } from "./draft_storage";

const files = (): DraftAttachment[] =>
  ["one", "two", "three"].map((name) => ({
    id: name,
    kind: "file",
    name: `${name}.txt`,
    uri: `file:///chosen/${name}.txt`,
    content: "previous contents",
  }));
afterEach(() => h.invoke.mockReset());

it("prepares three files without exceeding the shared read-check capacity", async () => {
  let active = 0;
  let peak = 0;
  h.invoke.mockImplementation(async (_command, { uri }) => {
    active++;
    peak = Math.max(peak, active);
    if (active > 2) {
      active--;
      throw new Error("two real file checks are still in flight");
    }
    // Complete at an async boundary, like a native file-check response.
    await Promise.resolve();
    active--;
    return `fresh:${uri}`;
  });
  const selected = files();
  const prepared = await prepareDraftAttachments(selected, true);
  expect(prepared.map((attachment) => attachment.content)).toEqual(
    selected.map((attachment) => `fresh:${attachment.uri}`),
  );
  expect(prepared.map((attachment) => attachment.id)).toEqual([
    "one",
    "two",
    "three",
  ]);
  expect(peak).toBe(1);
  expect(
    selected.every((attachment) => attachment.content === "previous contents"),
  ).toBe(true);
});

it("leaves the original batch intact and starts no later read after a failure", async () => {
  const selected = files();
  const original = structuredClone(selected);
  h.invoke
    .mockResolvedValueOnce("fresh first contents")
    .mockRejectedValueOnce("file check is still running");
  await expect(prepareDraftAttachments(selected, true)).rejects.toThrow(
    DRAFT_STRINGS.attachmentFailed,
  );
  expect(h.invoke.mock.calls).toEqual([
    ["draft_attachment_check", { uri: selected[0]!.uri, embed: true }],
    ["draft_attachment_check", { uri: selected[1]!.uri, embed: true }],
  ]);
  expect(selected).toEqual(original);
});
