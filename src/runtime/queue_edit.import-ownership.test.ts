import { File as NodeFile } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  disk: null as unknown,
  writes: [] as unknown[],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

type Drafts = typeof import("./drafts");
let d: Drafts;
let editing: typeof import("./queue_edit");
let importImages: typeof import("./composer_attachment_import");
const threadKey = "queue-transfer-owned-image";
const mainKey = `session:${threadKey}`;
const editKey = `queue-edit:${threadKey}`;
const original = [{ type: "text" as const, text: "paused original" }];
const tasks: Promise<void>[] = [];
const inputs: { finish(): Promise<void> }[] = [];
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function selected() {
  const file = new NodeFile(
    [Buffer.from(PNG_IMAGE_TEST_DATA, "base64")],
    "retained.png",
    { type: "image/png" },
  );
  const actualRead = file.arrayBuffer.bind(file);
  let deliver!: (bytes: ArrayBuffer) => void;
  let finished = false;
  const pending = new Promise<ArrayBuffer>((resolve) => {
    deliver = resolve;
  });
  const read = vi.spyOn(file, "arrayBuffer").mockImplementation(() => pending);
  const input = {
    file: file as unknown as File,
    read,
    async finish() {
      if (finished) return;
      finished = true;
      deliver(await actualRead());
    },
  };
  inputs.push(input);
  return input;
}

function begin() {
  const input = selected();
  const report = vi.fn();
  const importing = importImages.addClipboardImages(
    editKey,
    [input.file],
    report,
  );
  tasks.push(importing);
  return { input, report, importing };
}

beforeEach(async () => {
  vi.resetModules();
  h.disk = null;
  h.writes.length = 0;
  h.invoke.mockReset();
  h.invoke.mockImplementation(
    async (command: string, args: { value?: unknown }) => {
      if (command === "settings_get") return structuredClone(h.disk);
      if (command === "settings_set") {
        h.disk = structuredClone(args.value);
        h.writes.push(h.disk);
        return;
      }
      throw new Error(
        "Unexpected command outside settings-only fixture: " + command,
      );
    },
  );
  vi.stubGlobal("Image", TestImageDecoder);
  d = await import("./drafts");
  editing = await import("./queue_edit");
  importImages = await import("./composer_attachment_import");
  await d.draftPersistence.load();
  d.composerDrafts.update(mainKey, () => ({
    text: "existing main draft",
    attachments: [
      { id: "main", kind: "file", name: "main.txt", uri: "file:///main.txt" },
    ],
  }));
  d.draftQueues.write(threadKey, [original], null);
  editing.startQueueEditor(threadKey, 0, original);
  await d.draftPersistence.flush();
  h.writes.length = 0;
});

afterEach(async () => {
  // A RED must not strand a real File promise or its save barrier.
  for (const input of inputs) await input.finish();
  await Promise.allSettled(tasks);
  await d.draftPersistence.flush();
  inputs.length = 0;
  tasks.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("retains a pending clipboard import until it can explicitly join the input, including cold read", async () => {
  const { input, report, importing } = begin();
  const source = d.composerDrafts.read(editKey);
  const main = d.composerDrafts.read(mainKey);
  expect(input.read).toHaveBeenCalledOnce();
  expect(source.attachments[0]?.loading).toBe(true);
  const moved = editing.keepQueueEditAsDraft(threadKey);
  let saved = false;
  const save = d.draftPersistence.flush().then(() => {
    saved = true;
  });
  await turn();
  console.info(
    "pending-transfer-observation",
    JSON.stringify({
      moved,
      sourceRetained: d.composerDrafts.read(editKey) === source,
      mainRetained: d.composerDrafts.read(mainKey) === main,
      saveSettledBeforeBytes: saved,
      mainAttachments: d.composerDrafts.read(mainKey).attachments,
    }),
  );
  expect.soft(moved).toBe(false);
  expect.soft(d.composerDrafts.read(editKey)).toBe(source);
  expect.soft(d.composerDrafts.read(mainKey)).toBe(main);
  expect.soft(saved).toBe(false);
  await input.finish();
  await importing;
  await save;
  expect.soft(d.composerDrafts.read(editKey).attachments[0]).toMatchObject({
    data: PNG_IMAGE_TEST_DATA,
    loading: false,
  });
  editing.keepQueueEditAsDraft(threadKey);
  await d.draftPersistence.flush();
  expect.soft(d.composerDrafts.read(mainKey).attachments[1]).toMatchObject({
    data: PNG_IMAGE_TEST_DATA,
    loading: false,
  });
  expect(d.composerDrafts.read(mainKey).text).toBe(
    "existing main draft\n\npaused original",
  );
  expect(d.draftQueues.read(threadKey)?.blocks).toEqual([original]);
  expect(report).not.toHaveBeenCalled();
  // A new module reads the actual serialized settings value, not a copied
  // expected draft. This is synthetic storage, not SQLite or native IPC.
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect.soft(cold.composerDrafts.read(mainKey).attachments[1]).toMatchObject({
    data: PNG_IMAGE_TEST_DATA,
    recovered: true,
  });
  expect(cold.draftQueues.read(threadKey)?.blocks).toEqual([original]);
  expect(
    h.invoke.mock.calls.every(
      ([command]) => command === "settings_get" || command === "settings_set",
    ),
  ).toBe(true);
});

it.each(["remove", "discard"] as const)(
  "keeps explicit %s withdrawal and late read separate from a later ready transfer",
  async (action) => {
    const { input, report, importing } = begin();
    if (action === "discard") d.composerDrafts.clear(editKey);
    else
      d.composerDrafts.update(editKey, (draft) => ({
        ...draft,
        attachments: [],
      }));
    await d.draftPersistence.flush();
    const main = d.composerDrafts.read(mainKey);
    await input.finish();
    await importing;
    expect(d.composerDrafts.read(mainKey)).toBe(main);
    expect(d.composerDrafts.read(editKey).attachments).toEqual([]);
    expect(report).not.toHaveBeenCalled();
    editing.startQueueEditor(threadKey, 0, original);
    const ready = begin();
    await ready.input.finish();
    await ready.importing;
    editing.keepQueueEditAsDraft(threadKey);
    await d.draftPersistence.flush();
    expect(d.composerDrafts.read(mainKey).attachments[1]).toMatchObject({
      data: PNG_IMAGE_TEST_DATA,
      loading: false,
    });
    expect(d.composerDrafts.read(editKey).queueEdit).toBeUndefined();
    expect(d.draftQueues.read(threadKey)?.blocks).toEqual([original]);
  },
);
