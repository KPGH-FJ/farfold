import { File as NativeFile } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn(), writes: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));

import { addClipboardImages } from "./composer_attachment_import";
import { composerDrafts, draftPersistence } from "./drafts";
import { clipboardImageCandidate, IMAGE_INPUT_STRINGS } from "./draft_images";
import { FILE_DELIVERY_STRINGS as F } from "./file_delivery_strings";
import { IMAGE_BYTES_STRINGS, MAX_IMAGE_BYTES } from "./image_bytes";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const releases: (() => void)[] = [];
const tasks: Promise<unknown>[] = [];

function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task);
  // Keep an intentionally rejected candidate observed until the assertion or
  // final cleanup consumes it. The original promise retains its outcome.
  void task.catch(() => {});
  return task;
}

function source(name: string) {
  const bytes = Buffer.from(PNG_IMAGE_TEST_DATA, "base64");
  const realFile = new NativeFile([bytes], name, { type: "image/png" });
  const actual = realFile.arrayBuffer.bind(realFile);
  const actualCompleted = deferred<void>();
  const delivery = deferred<void>();
  const read = vi.spyOn(realFile, "arrayBuffer").mockImplementation(() =>
    actual().then(async (buffer) => {
      actualCompleted.resolve();
      // The real owned Node File read has completed here. Only delivery to the
      // candidate is held; this is not evidence of physical I/O or RSS.
      await delivery.promise;
      return buffer;
    }),
  );
  const release = () => delivery.resolve();
  releases.push(release);
  return {
    file: realFile as unknown as File,
    read,
    actualCompleted: actualCompleted.promise,
    release,
    rejectDelivery: delivery.reject,
  };
}

function candidate(item: ReturnType<typeof source>) {
  return track(clipboardImageCandidate(item.file));
}

beforeEach(async () => {
  h.writes.length = 0;
  h.invoke.mockImplementation(
    async (command: string, args: { value?: unknown }) => {
      if (command === "settings_get") return null;
      if (command === "settings_set") {
        h.writes.push(structuredClone(args.value));
        return;
      }
      throw new Error("Unexpected command in owned image fixture: " + command);
    },
  );
  vi.stubGlobal("Image", TestImageDecoder);
  await draftPersistence.load();
  composerDrafts.clear("new");
  await draftPersistence.flush();
});

afterEach(async () => {
  for (const release of releases) release();
  const ended = await Promise.allSettled(tasks);
  // Both real File return promises and importer tasks have settled before the
  // next case. Rejections are expected only where the case asserted them.
  expect(ended).toHaveLength(tasks.length);
  composerDrafts.clear("new");
  await draftPersistence.flush();
  releases.length = 0;
  tasks.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("admits only two unfinished File candidates before reading or encoding and requires explicit retry", async () => {
  const a = source("a.png"),
    b = source("b.png"),
    c = source("c.png");
  const encoding = vi.spyOn(globalThis, "btoa");
  const first = candidate(a);
  const second = candidate(b);
  await Promise.all([a.actualCompleted, b.actualCompleted]);
  await expect(candidate(c)).rejects.toThrow(F.checkBusy);
  expect(a.read).toHaveBeenCalledOnce();
  expect(b.read).toHaveBeenCalledOnce();
  expect(c.read).not.toHaveBeenCalled();
  expect(encoding).not.toHaveBeenCalled();

  a.release();
  expect(await first).toEqual({
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
  });
  expect(c.read).not.toHaveBeenCalled();
  const retry = candidate(c);
  await c.actualCompleted;
  expect(c.read).toHaveBeenCalledOnce();
  c.release();
  expect(await retry).toEqual({
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
  });
  b.release();
  await second;
});

it("withdrawal releases the draft save wait while actual unfinished candidates keep both preparation slots", async () => {
  const a = source("withdrawn-a.png"),
    b = source("withdrawn-b.png"),
    c = source("after-withdrawal.png");
  const report = vi.fn();
  const encoding = vi.spyOn(globalThis, "btoa");
  const first = track(addClipboardImages("new", [a.file], report));
  const second = track(addClipboardImages("new", [b.file], report));
  await Promise.all([a.actualCompleted, b.actualCompleted]);

  composerDrafts.update("new", () => ({
    text: "new text after withdrawing old images",
    attachments: [],
  }));
  await draftPersistence.flush();
  const saved = h.writes.at(-1) as {
    composers: Record<string, { text: string; attachments: unknown[] }>;
  };
  expect(saved.composers.new.text).toBe(
    "new text after withdrawing old images",
  );
  expect(saved.composers.new.attachments).toEqual([]);

  await track(addClipboardImages("new", [c.file], report));
  expect(report).toHaveBeenCalledWith(F.checkBusy);
  expect(c.read).not.toHaveBeenCalled();
  expect(encoding).not.toHaveBeenCalled();
  a.release();
  b.release();
  await Promise.all([first, second]);
  expect(c.read).not.toHaveBeenCalled();
  expect(composerDrafts.read("new").text).toBe(
    "new text after withdrawing old images",
  );
  expect(composerDrafts.read("new").attachments.some((item) => item.data)).toBe(
    false,
  );
  const retry = candidate(c);
  await c.actualCompleted;
  c.release();
  expect((await retry).data).toBe(PNG_IMAGE_TEST_DATA);
});

it.each(["empty", "oversized"] as const)(
  "%s File keeps its original size error ahead of preparation busy and performs no read",
  async (kind) => {
    const a = source("a.png"),
      b = source("b.png");
    candidate(a);
    candidate(b);
    await Promise.all([a.actualCompleted, b.actualCompleted]);
    const file = new NativeFile(
      [
        kind === "empty"
          ? new Uint8Array()
          : new Uint8Array(MAX_IMAGE_BYTES + 1),
      ],
      "invalid-size.png",
      { type: "image/png" },
    );
    const read = vi.spyOn(file, "arrayBuffer");
    await expect(
      track(clipboardImageCandidate(file as unknown as File)),
    ).rejects.toThrow(
      kind === "empty"
        ? IMAGE_INPUT_STRINGS.invalid
        : IMAGE_BYTES_STRINGS.tooLarge,
    );
    expect(read).not.toHaveBeenCalled();
  },
);

it("releases the preparation slot after the actual File return promise rejects without retrying the rejected third file", async () => {
  const a = source("rejected.png"),
    b = source("held.png"),
    c = source("busy.png");
  const first = candidate(a);
  candidate(b);
  await Promise.all([a.actualCompleted, b.actualCompleted]);
  await expect(candidate(c)).rejects.toThrow(F.checkBusy);
  const failure = new Error("owned controlled File delivery rejection");
  // This controls the File API rejection path after a real read; it does not
  // claim that an OS read failed on this machine.
  a.rejectDelivery(failure);
  await expect(first).rejects.toBe(failure);
  expect(c.read).not.toHaveBeenCalled();
  const retry = candidate(c);
  await c.actualCompleted;
  expect(c.read).toHaveBeenCalledOnce();
  c.release();
  expect((await retry).data).toBe(PNG_IMAGE_TEST_DATA);
});

it("returns capacity exactly once when File.arrayBuffer throws synchronously", async () => {
  const throwing = new NativeFile([new Uint8Array([1])], "throwing.png");
  const failure = new Error("owned synchronous File API failure");
  const read = vi.spyOn(throwing, "arrayBuffer").mockImplementation(() => {
    throw failure;
  });
  await expect(
    track(clipboardImageCandidate(throwing as unknown as File)),
  ).rejects.toBe(failure);
  expect(read).toHaveBeenCalledOnce();
  const a = source("a.png"),
    b = source("b.png"),
    c = source("busy.png");
  candidate(a);
  candidate(b);
  await Promise.all([a.actualCompleted, b.actualCompleted]);
  expect(a.read).toHaveBeenCalledOnce();
  expect(b.read).toHaveBeenCalledOnce();
  await expect(candidate(c)).rejects.toThrow(F.checkBusy);
  expect(c.read).not.toHaveBeenCalled();
});
