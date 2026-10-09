import { expect, it, vi } from "vitest";
import { PreviewCapture, samePreviewFile } from "./preview_capture";
const file = {
  root: "/work",
  path: "/work/a",
  resolvedPath: "/work/a",
  name: "a",
  size: 1,
  version: "v",
  sha256: "h",
};
it("waits for a single outstanding capture even across cancel/retry intent and keeps an unknown receipt until explicit retry", async () => {
  const reader = new PreviewCapture<number>();
  let reject!: (e: unknown) => void;
  const read = vi.fn((_file, signal) => {
    expect(signal.aborted).toBe(false);
    return new Promise<number>((_, no) => (reject = no));
  });
  const first = reader.read(file, 0, read);
  const second = reader.read({ ...file }, 1, read);
  expect(first).toBe(second);
  const failed = expect(first).rejects.toThrow("readPending");
  await Promise.resolve();
  expect(read).toHaveBeenCalledOnce();
  reject(new Error("readPending"));
  await failed;
  await expect(reader.read(file, 1, read)).rejects.toThrow("readPending");
  expect(read).toHaveBeenCalledOnce();
  const known = vi.fn(async () => 9);
  expect(await reader.read(file, 2, known)).toBe(9);
  expect(known).toHaveBeenCalledOnce();
  expect(await reader.read(file, 3, read)).toBe(9);
  expect(read).toHaveBeenCalledOnce();
});
it("does not borrow bytes across file versions or redirected paths; release only drops successful matching capture", async () => {
  const reader = new PreviewCapture<number>(),
    read = vi.fn(async () => 7);
  await reader.read(file, 0, read);
  reader.release({ ...file, version: "other" });
  await reader.read(file, 0, read);
  expect(read).toHaveBeenCalledOnce();
  reader.release(file);
  await reader.read(file, 0, read);
  expect(read).toHaveBeenCalledTimes(2);
  await reader.read({ ...file, sha256: "other" }, 0, read);
  expect(read).toHaveBeenCalledTimes(3);
  expect(samePreviewFile(file, { ...file, resolvedPath: "/else" })).toBe(false);
});
it("retains synchronous capture errors as failed receipts too", async () => {
  const reader = new PreviewCapture<number>(),
    read = vi.fn(() => {
      throw new Error("readBusy");
    });
  await expect(reader.read(file, 0, read)).rejects.toThrow("readBusy");
  await expect(reader.read(file, 0, read)).rejects.toThrow("readBusy");
  expect(read).toHaveBeenCalledOnce();
});
