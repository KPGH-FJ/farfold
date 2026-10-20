import { File as NodeFile } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  writes: [] as unknown[],
  failSave: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import {
  addClipboardImages,
  addPickedAttachments,
} from "./composer_attachment_import";
import {
  composerDrafts,
  draftPersistence,
  type DraftAttachment,
} from "./drafts";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

// Real Node File bytes; only its arrayBuffer delivery is controlled. The actual
// importer, draft store and persistence implementation remain in use. The
// existing decoder peer is not browser, installed-product or physical-stop proof.
const key = "new";
const other = "session:clipboard-save-other";
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const tasks: Promise<void>[] = [];
const inputs: ReturnType<typeof selected>[] = [];
function selected(name = "owned-pending.png") {
  const file = new NodeFile(
    [Buffer.from(PNG_IMAGE_TEST_DATA, "base64")],
    name,
    {
      type: "image/png",
    },
  );
  const actualRead = file.arrayBuffer.bind(file);
  let resolve!: (value: ArrayBuffer) => void;
  let reject!: (reason: Error) => void;
  let delivered = false;
  const pending = new Promise<ArrayBuffer>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const read = vi.spyOn(file, "arrayBuffer").mockImplementation(() => pending);
  const value = {
    file: file as unknown as File,
    read,
    async finish() {
      if (delivered) return;
      delivered = true;
      resolve(await actualRead());
    },
    fail() {
      if (delivered) return;
      delivered = true;
      reject(new Error("owned deferred File failure"));
    },
  };
  inputs.push(value);
  return value;
}
function begin(files: readonly File[]) {
  const report = vi.fn();
  const task = addClipboardImages(key, files, report);
  tasks.push(task);
  return { task, report };
}
function saving() {
  let saved = false;
  const task = draftPersistence.flush().then(() => {
    saved = true;
  });
  return { task, saved: () => saved };
}
function latestSaved(target: string) {
  const saved = h.writes.at(-1) as {
    composers: Record<string, { text: string; attachments: DraftAttachment[] }>;
  };
  return saved.composers[target];
}
beforeEach(async () => {
  h.failSave = false;
  h.invoke.mockImplementation(
    async (name: string, args: { value?: unknown }) => {
      if (name === "settings_get") return null;
      if (name === "settings_set") {
        if (h.failSave) throw new Error("owned settings write failure");
        h.writes.push(structuredClone(args.value));
        return;
      }
      throw new Error("Unexpected IPC outside settings-only seam: " + name);
    },
  );
  vi.stubGlobal("Image", TestImageDecoder);
  await draftPersistence.load();
  composerDrafts.clear(key);
  composerDrafts.clear(other);
  await draftPersistence.flush();
  h.writes.length = 0;
});
afterEach(async () => {
  // Always settle real promises, including when an assertion is RED. Releasing
  // a save wait never means that the original File operation stopped.
  for (const input of inputs) await input.finish();
  await Promise.allSettled(tasks);
  draftPersistence.lockInteraction(false);
  h.failSave = false;
  composerDrafts.clear(key);
  composerDrafts.clear(other);
  await draftPersistence.flush();
  inputs.length = 0;
  tasks.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps owned input behind save across another draft and the quit interaction lock", async () => {
  const input = selected();
  const imported = begin([input.file]);
  composerDrafts.update(other, () => ({
    text: "other retained draft",
    attachments: [],
  }));
  draftPersistence.lockInteraction(true);
  const flush = saving();
  await turn();
  expect(input.read).toHaveBeenCalledOnce();
  expect(flush.saved()).toBe(false);
  expect(h.writes).toHaveLength(0);
  await input.finish();
  await imported.task;
  await flush.task;
  expect(latestSaved(key).attachments[0]?.data).toBe(PNG_IMAGE_TEST_DATA);
  expect(latestSaved(other).text).toBe("other retained draft");
  expect(imported.report).not.toHaveBeenCalled();
});

it.each(["remove", "clear"] as const)(
  "saves replacement input after %s without waiting for the withdrawn File",
  async (action) => {
    const input = selected();
    const imported = begin([input.file]);
    const original = composerDrafts.read(key).attachments[0]!;
    if (action === "clear") composerDrafts.clear(key);
    composerDrafts.update(key, (draft) => ({
      ...draft,
      text: "replacement input",
      attachments: draft.attachments.filter((item) => item !== original),
    }));
    const replacement = composerDrafts.read(key);
    const flush = saving();
    await turn();
    expect(flush.saved()).toBe(true);
    expect(latestSaved(key).text).toBe("replacement input");
    expect(latestSaved(key).attachments).toEqual([]);
    await input.finish();
    await imported.task;
    expect(composerDrafts.read(key)).toBe(replacement);
    expect(imported.report).not.toHaveBeenCalled();
  },
);

it("does not let completed retained A pin the removed unfinished B", async () => {
  const a = selected("a.png"),
    b = selected("b.png");
  const imported = begin([a.file, b.file]);
  await a.finish();
  await turn();
  expect(b.read).toHaveBeenCalledOnce();
  const [complete, pending] = composerDrafts.read(key).attachments;
  expect(complete?.loading).toBe(false);
  expect(complete?.data).toBe(PNG_IMAGE_TEST_DATA);
  expect(pending?.loading).toBe(true);
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item === complete),
  }));
  const flush = saving();
  await turn();
  expect(flush.saved()).toBe(true);
  expect(latestSaved(key).attachments).toHaveLength(1);
  expect(latestSaved(key).attachments[0]?.data).toBe(PNG_IMAGE_TEST_DATA);
  await b.finish();
  await imported.task;
  expect(composerDrafts.read(key).attachments).toEqual([complete]);
});

it("keeps future owned B protected when removed in-flight A still has not returned", async () => {
  const a = selected("a.png"),
    b = selected("b.png");
  const imported = begin([a.file, b.file]);
  const originalA = composerDrafts.read(key).attachments[0]!;
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item !== originalA),
  }));
  const flush = saving();
  await turn();
  expect(b.read).not.toHaveBeenCalled();
  expect(flush.saved()).toBe(false);
  expect(h.writes).toHaveLength(0);
  await a.finish();
  await turn();
  expect(b.read).toHaveBeenCalledOnce();
  expect(flush.saved()).toBe(false);
  await b.finish();
  await imported.task;
  await flush.task;
  expect(latestSaved(key).attachments).toHaveLength(1);
  expect(latestSaved(key).attachments[0]?.name).toBe("b.png");
  expect(latestSaved(key).attachments[0]?.data).toBe(PNG_IMAGE_TEST_DATA);
});

it("does not overwrite changed content under the same attachment ID and URI", async () => {
  const input = selected();
  const imported = begin([input.file]);
  const original = composerDrafts.read(key).attachments[0]!;
  const changed = {
    ...original,
    loading: false,
    data: "bmV3",
    name: "replacement",
  };
  composerDrafts.update(key, (draft) => ({ ...draft, attachments: [changed] }));
  const flush = saving();
  await turn();
  expect(flush.saved()).toBe(true);
  await input.finish();
  await imported.task;
  expect(composerDrafts.read(key).attachments).toEqual([changed]);
  expect(imported.report).not.toHaveBeenCalled();
});

it("cannot regain write ownership after the exact old object is removed then reinserted", async () => {
  const input = selected();
  const imported = begin([input.file]);
  const original = composerDrafts.read(key).attachments[0]!;
  composerDrafts.update(key, (draft) => ({ ...draft, attachments: [] }));
  composerDrafts.update(key, (draft) => ({
    ...draft,
    attachments: [original],
  }));
  await input.finish();
  await imported.task;
  expect(composerDrafts.read(key).attachments).toEqual([original]);
  expect(composerDrafts.read(key).attachments[0]?.data).toBeUndefined();
  expect(imported.report).not.toHaveBeenCalled();
  // This is an imperative-store ABA guard, not a claim that a reinserted
  // incomplete attachment is ready to send or is a successful imported image.
});

it("keeps save failure real and ignores a retired File's later rejection", async () => {
  const input = selected();
  const imported = begin([input.file]);
  h.failSave = true;
  composerDrafts.clear(key);
  composerDrafts.update(key, () => ({
    text: "retain after save failure",
    attachments: [],
  }));
  await expect(draftPersistence.flush()).rejects.toThrow();
  expect(draftPersistence.snapshot().error).toBeTruthy();
  const replacement = composerDrafts.read(key);
  input.fail();
  await imported.task;
  expect(composerDrafts.read(key)).toBe(replacement);
  expect(imported.report).not.toHaveBeenCalled();
  h.failSave = false;
  await draftPersistence.flush();
  expect(latestSaved(key).text).toBe("retain after save failure");
  expect(draftPersistence.snapshot().error).toBeNull();
});

it("wakes an already waiting save after a chosen file is withdrawn during classification", async () => {
  let deliver!: (value: null) => void;
  const classification = new Promise<null>((resolve) => {
    deliver = resolve;
  });
  const settings = h.invoke.getMockImplementation()!;
  h.invoke.mockImplementation((name: string, args: unknown) =>
    name === "draft_attachment_audio_candidate"
      ? classification
      : settings(name, args),
  );
  const report = vi.fn();
  const importing = addPickedAttachments(
    key,
    ["/chosen/pending.png"],
    true,
    report,
  );
  tasks.push(importing);
  const flush = saving();
  try {
    await turn();
    expect(flush.saved()).toBe(false);
    expect(h.writes).toHaveLength(0);
    composerDrafts.update(key, () => ({
      text: "keep chosen-file replacement",
      attachments: [],
    }));
    await turn();
    expect(flush.saved()).toBe(true);
    expect(latestSaved(key).text).toBe("keep chosen-file replacement");
  } finally {
    deliver(null);
    await importing;
    await flush.task;
  }
  expect(composerDrafts.read(key).attachments).toEqual([]);
  expect(report).not.toHaveBeenCalled();
  expect(
    h.invoke.mock.calls.some(([name]) => name === "draft_attachment_image"),
  ).toBe(false);
});
