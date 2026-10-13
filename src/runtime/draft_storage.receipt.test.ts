import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
it("never reports a requested revision saved until the latest serialized write has completed", async () => {
  const first = defer(),
    second = defer();
  const written: unknown[] = [];
  h.invoke.mockImplementation(async (name, input) => {
    if (name === "settings_get") return null;
    written.push(input.value);
    await (written.length === 1 ? first.promise : second.promise);
  });
  const d = await import("./drafts");
  const p = d.draftPersistence;
  expect(p.isSaved(0)).toBe(false);
  await p.load();
  for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(p.isSaved(bad)).toBe(false);
  d.composerDrafts.update("new", () => ({ text: "FIRST", attachments: [] }));
  const firstRevision = p.revision();
  await vi.waitFor(() => expect(written).toHaveLength(1));
  d.composerDrafts.update("new", () => ({ text: "SECOND", attachments: [] }));
  const secondRevision = p.revision();
  first.resolve();
  await vi.waitFor(() => expect(written).toHaveLength(2));
  expect(p.isSaved(firstRevision)).toBe(false);
  expect(p.isSaved(secondRevision)).toBe(false);
  second.resolve();
  await p.flush();
  expect(p.isSaved(firstRevision)).toBe(true);
  expect(p.isSaved(secondRevision)).toBe(true);
  expect(p.isSaved(secondRevision + 1)).toBe(false);
  expect(written[1]).toMatchObject({ composers: { new: { text: "SECOND" } } });
  expect(written[1]).not.toHaveProperty("revision");
  expect(written[1]).not.toHaveProperty("savedRevision");
});
it("distinguishes only a local write failure and does not mistake retry start for success", async () => {
  let failing = true;
  const retryWrite = defer();
  h.invoke.mockImplementation(async (name) => {
    if (name === "settings_get") return null;
    if (failing) throw new Error("disk failure");
    await retryWrite.promise;
  });
  const d = await import("./drafts"),
    { DraftSaveError } = await import("./draft_storage");
  const p = d.draftPersistence;
  await p.load();
  d.composerDrafts.update("new", () => ({ text: "RETAIN", attachments: [] }));
  const revision = p.revision();
  await expect(p.flush()).rejects.toMatchObject({
    constructor: DraftSaveError,
    revision,
  });
  expect(p.isSaved(revision)).toBe(false);
  failing = false;
  const retry = p.flush();
  await vi.waitFor(() => expect(p.snapshot().saving).toBe(true));
  expect(p.snapshot().error).toBeNull();
  expect(p.isSaved(revision)).toBe(false);
  retryWrite.resolve();
  await retry;
  expect(p.isSaved(revision)).toBe(true);
});
it("load failure is not a completed write failure and never grants a saved receipt", async () => {
  h.invoke.mockRejectedValue(new Error("unread data"));
  const { draftPersistence: p, DraftSaveError } =
    await import("./draft_storage");
  let failure: unknown;
  try {
    await p.flush();
  } catch (error) {
    failure = error;
  }
  expect(failure).not.toBeInstanceOf(DraftSaveError);
  expect(p.isSaved(p.revision())).toBe(false);
  expect(h.invoke.mock.calls.every(([name]) => name === "settings_get")).toBe(
    true,
  );
});
it("pending attachment capture and unrelated storage signals do not constitute a saved revision", async () => {
  h.invoke.mockResolvedValue(null);
  const d = await import("./drafts"),
    p = d.draftPersistence;
  await p.load();
  const capture = defer();
  p.trackAttachment(capture.promise);
  d.composerDrafts.update("new", () => ({ text: "WAIT", attachments: [] }));
  const revision = p.revision();
  const release = p.acquireInteractionLock();
  release();
  await Promise.resolve();
  expect(p.snapshot().saving).toBe(false);
  expect(p.isSaved(revision)).toBe(false);
  expect(
    h.invoke.mock.calls.filter(([name]) => name === "settings_set"),
  ).toHaveLength(0);
  capture.resolve();
  await p.flush();
  expect(p.isSaved(revision)).toBe(true);
});
