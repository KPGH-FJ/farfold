import { expect, it, vi } from "vitest";
import { TextBlockReader } from "./text_block_reader";
import type { TextBlockPreview } from "./text_block_preview";
const file = {
  root: "/w",
  path: "a",
  resolvedPath: "/w/a",
  name: "a",
  size: 6,
  version: "1",
  sha256: "h",
};
const initial: TextBlockPreview = {
  file,
  blockIndex: 0,
  blockCount: 2,
  byteStart: 0,
  byteEnd: 3,
  startLine: 1,
  endLine: 1,
  startsMidLine: false,
  endsMidLine: true,
  text: "abc",
};
const next = {
  ...initial,
  blockIndex: 1,
  byteStart: 3,
  byteEnd: 6,
  startsMidLine: true,
  endsMidLine: false,
  text: "def",
};
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
it("keeps original contents during read and publishes only exact requested result", async () => {
  const pending = deferred<TextBlockPreview>();
  const read = vi.fn(() => pending.promise);
  const r = new TextBlockReader(initial, read);
  const status = vi.fn();
  r.onStatus = status;
  const operation = r.go(1);
  expect(r.snapshot().block).toBe(initial);
  expect(r.snapshot().phase).toBe("loading");
  await r.go(0);
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(next);
  await operation;
  expect(r.snapshot().block).toBe(next);
  expect(status).toHaveBeenLastCalledWith({
    file,
    state: "ready",
    code: undefined,
    readInFlight: false,
  });
});
it.each(["hide", "cancel"])(
  "%s does not cancel OS wait, publish late contents, or permit overlapping reads",
  async (kind) => {
    const pending = deferred<TextBlockPreview>();
    const read = vi.fn(() => pending.promise);
    const r = new TextBlockReader(initial, read);
    const operation = r.go(1);
    if (kind === "hide") {
      r.setActive(false);
      r.setActive(true);
    } else r.cancel();
    await r.go(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(r.isBusy()).toBe(true);
    pending.resolve(next);
    await operation;
    expect(r.snapshot().block).toBe(initial);
    expect(r.snapshot().phase).toBe("paused");
    expect(r.isBusy()).toBe(false);
  },
);
it("keeps late hidden pending evidence and never retries on visibility", async () => {
  const p = deferred<TextBlockPreview>();
  const read = vi.fn(() => p.promise);
  const r = new TextBlockReader(initial, read);
  const status = vi.fn();
  r.onStatus = status;
  const operation = r.go(1);
  r.setActive(false);
  p.reject({ code: "pending" });
  await operation;
  r.setActive(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(r.snapshot()).toMatchObject({
    block: initial,
    phase: "failed",
    code: "pending",
  });
  expect(status).toHaveBeenLastCalledWith({
    file,
    state: "failed",
    code: "pending",
    readInFlight: false,
  });
  read.mockResolvedValue(next);
  await r.go(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(r.snapshot().block).toBe(next);
});
it("rejects navigation outside the existing receipt and ignores actions while inactive", async () => {
  const read = vi.fn();
  const r = new TextBlockReader(initial, read);
  for (const n of [-1, 2, NaN, 1.5]) await r.go(n);
  r.setActive(false);
  await r.go(1);
  expect(read).not.toHaveBeenCalled();
});
