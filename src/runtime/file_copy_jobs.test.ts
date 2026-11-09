import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileCopyJobs } from "./file_copy_jobs";
import type { CopyStatus } from "./file_copy_types";
const file = {
  root: "/w",
  path: "a",
  resolvedPath: "/w/a",
  name: "a",
  size: 6,
  version: "1",
  sha256: "h",
};
const ready: CopyStatus = {
  operationId: "op-1",
  file,
  destination: "/out/a",
  state: "ready",
  settled: false,
  bytesCopied: 0,
  total: 6,
};
const completed: CopyStatus = {
  ...ready,
  state: "completed",
  settled: true,
  bytesCopied: 6,
  receipt: {
    kind: "fileCopy",
    destination: "/out/a",
    size: 6,
    sha256: "h",
    sourceVersion: "1",
  },
};
const port = () => ({
  prepare: vi.fn().mockResolvedValue(ready),
  start: vi.fn().mockResolvedValue({ ...ready, state: "copying" }),
  status: vi.fn().mockResolvedValue(completed),
  cancel: vi
    .fn()
    .mockResolvedValue({ ...ready, state: "cancelled", settled: true }),
  release: vi.fn().mockResolvedValue(true),
});
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("uses one observed job across callers and releases only after explicit dismissal", async () => {
  const api = port(),
    jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  await jobs.begin(file, "/out/a");
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(jobs.hasUnsettled()).toBe(true);
  await vi.advanceTimersByTimeAsync(800);
  expect(jobs.getSnapshot()[0].status).toEqual(completed);
  expect(jobs.hasUnsettled()).toBe(false);
  expect(api.release).not.toHaveBeenCalled();
  await jobs.dismiss(1);
  expect(api.release).toHaveBeenCalledWith("op-1");
  expect(jobs.getSnapshot()).toEqual([]);
});
it.each([
  ["file", { ...file, path: "b", resolvedPath: "/w/b", name: "b" }],
  ["version", { ...file, version: "2", sha256: "new" }],
] as const)(
  "reports a different %s attempting the active destination as busy",
  async (_kind, other) => {
    const api = port();
    const jobs = new FileCopyJobs(api);
    await jobs.begin(file, "/out/a");
    const [original] = jobs.getSnapshot();
    expect(original.status?.state).toBe("copying");

    await expect(jobs.begin(other, "/out/a")).rejects.toEqual({ code: "busy" });

    expect(jobs.getSnapshot()).toEqual([original]);
    expect(api.prepare).toHaveBeenCalledExactlyOnceWith(file, "/out/a");
    expect(api.start).toHaveBeenCalledExactlyOnceWith("op-1");
    expect(api.cancel).not.toHaveBeenCalled();
    await jobs.check(original.id);
    expect(jobs.getSnapshot()[0].status).toEqual(completed);
  },
);
it("never starts an unconfirmed prepare, and allows its not-started record to close", async () => {
  const api = port();
  api.prepare.mockRejectedValue(new Error("transport"));
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  expect(api.start).not.toHaveBeenCalled();
  expect(jobs.getSnapshot()[0].phase).toBe("notStarted");
  expect(jobs.hasUnsettled()).toBe(false);
  await jobs.dismiss(1);
  expect(jobs.getSnapshot()).toEqual([]);
});
it("a prepare withdrawn while awaiting receipt cancels only that late ready job", async () => {
  const p = deferred<unknown>(),
    api = port();
  api.prepare.mockReturnValue(p.promise);
  const jobs = new FileCopyJobs(api);
  const begin = jobs.begin(file, "/out/a");
  expect(jobs.hasUnsettled()).toBe(true);
  await jobs.cancel(1);
  p.resolve(ready);
  await begin;
  expect(api.start).not.toHaveBeenCalled();
  expect(api.cancel).toHaveBeenCalledWith("op-1");
  expect(jobs.getSnapshot()[0].status?.state).toBe("cancelled");
});
it("start rejection retains exact ID, blocks duplicate starts, and resolves by read-only status", async () => {
  const api = port();
  api.start.mockRejectedValue(new Error("receipt lost"));
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  expect(jobs.getSnapshot()[0].phase).toBe("uncertain");
  await jobs.begin(file, "/out/a");
  await jobs.dismiss(1);
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(jobs.hasUnsettled()).toBe(true);
  await jobs.check(1);
  expect(api.status).toHaveBeenCalledWith("op-1");
  expect(jobs.getSnapshot()[0].status).toEqual(completed);
  expect(api.start).toHaveBeenCalledTimes(1);
});
it("null, mismatched source/destination and false completed receipts remain unknown", async () => {
  for (const value of [
    null,
    { ...completed, operationId: "other" },
    { ...completed, file: { ...file, version: "2" } },
    { ...completed, destination: "/other" },
    { ...completed, receipt: { ...completed.receipt, sha256: "bad" } },
  ]) {
    const api = port();
    api.start.mockResolvedValue(value);
    const jobs = new FileCopyJobs(api);
    await jobs.begin(file, "/out/a");
    expect(jobs.getSnapshot()[0].phase).toBe("uncertain");
    expect(jobs.hasUnsettled()).toBe(true);
    await jobs.dismiss(1);
    expect(api.release).not.toHaveBeenCalled();
  }
});
it("publishing cancel takes authoritative completed receipt rather than claiming cancellation", async () => {
  const api = port();
  api.start.mockResolvedValue({ ...ready, state: "publishing" });
  api.cancel.mockResolvedValue(completed);
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  await jobs.cancel(1);
  expect(jobs.getSnapshot()[0].status).toEqual(completed);
  expect(jobs.hasUnsettled()).toBe(false);
});
it("queues cancellation behind one status call, without overlapping mutations", async () => {
  const p = deferred<unknown>(),
    api = port();
  api.status.mockReturnValue(p.promise);
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  const check = jobs.check(1);
  await jobs.cancel(1);
  expect(api.cancel).not.toHaveBeenCalled();
  p.resolve({ ...ready, state: "copying" });
  await check;
  await Promise.resolve();
  expect(api.cancel).toHaveBeenCalledTimes(1);
});
it("unknown cancellation never becomes cancelled or eligible for dismissal", async () => {
  const api = port();
  api.cancel.mockResolvedValue(null);
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  await jobs.cancel(1);
  expect(jobs.getSnapshot()[0].phase).toBe("uncertain");
  await jobs.dismiss(1);
  expect(api.release).not.toHaveBeenCalled();
});
it("a never-returning start becomes queryable unknown; its late older reply cannot undo completion", async () => {
  const p = deferred<unknown>(),
    api = port();
  api.start.mockReturnValue(p.promise);
  const jobs = new FileCopyJobs(api);
  const begin = jobs.begin(file, "/out/a");
  await vi.advanceTimersByTimeAsync(10_001);
  await begin;
  expect(jobs.getSnapshot()[0]).toMatchObject({
    phase: "uncertain",
    checking: false,
  });
  await jobs.check(1);
  expect(jobs.getSnapshot()[0].status).toEqual(completed);
  p.resolve({ ...ready, state: "copying" });
  await Promise.resolve();
  await Promise.resolve();
  expect(jobs.getSnapshot()[0].status).toEqual(completed);
  expect(api.start).toHaveBeenCalledTimes(1);
});
it("expired preparation never starts late and releases exit protection after withdrawing intent", async () => {
  const p = deferred<unknown>(),
    api = port();
  api.prepare.mockReturnValue(p.promise);
  const jobs = new FileCopyJobs(api);
  const begin = jobs.begin(file, "/out/a");
  await vi.advanceTimersByTimeAsync(10_001);
  await begin;
  expect(jobs.getSnapshot()[0]).toMatchObject({
    phase: "notStarted",
    checking: false,
  });
  expect(jobs.hasUnsettled()).toBe(false);
  p.resolve(ready);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(api.start).not.toHaveBeenCalled();
  expect(api.cancel).toHaveBeenCalledWith("op-1");
});
it("ready after an unconfirmed start does not prove no delayed start can still arrive", async () => {
  const p = deferred<unknown>(),
    api = port();
  api.start.mockReturnValue(p.promise);
  api.status.mockResolvedValue(ready);
  const jobs = new FileCopyJobs(api);
  const begin = jobs.begin(file, "/out/a");
  await vi.advanceTimersByTimeAsync(10_001);
  await begin;
  await jobs.check(1);
  expect(jobs.getSnapshot()[0].phase).toBe("uncertain");
  expect(jobs.hasUnsettled()).toBe(true);
  expect(api.start).toHaveBeenCalledTimes(1);
});
it("release false or lost receipt does not silently remove a visible final record", async () => {
  const api = port();
  api.start.mockResolvedValue(completed);
  api.release.mockResolvedValue(false);
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  await jobs.dismiss(1);
  expect(jobs.getSnapshot()[0]).toMatchObject({
    closeFailed: true,
    status: completed,
  });
  expect(jobs.hasUnsettled()).toBe(false);
  api.release.mockResolvedValue(true);
  await jobs.dismiss(1);
  expect(jobs.getSnapshot()).toEqual([]);
});
it("only an authoritative settled unknown allows exit and explicit unknown acknowledgement", async () => {
  for (const settled of [false, true]) {
    const api = port();
    api.start.mockResolvedValue({
      ...ready,
      state: "unknown",
      settled,
      code: "cleanupUnknown",
    });
    const jobs = new FileCopyJobs(api);
    await jobs.begin(file, "/out/a");
    expect(jobs.hasUnsettled()).toBe(!settled);
    await jobs.dismiss(1);
    expect(jobs.getSnapshot()).toHaveLength(1);
    await jobs.dismiss(1, true);
    expect(jobs.getSnapshot()).toHaveLength(settled ? 0 : 1);
  }
});
it("a trustworthy settled unknown cannot regress to active work via later status checks", async () => {
  const api = port();
  api.start.mockResolvedValue({
    ...ready,
    state: "unknown",
    settled: true,
    code: "cleanupUnknown",
  });
  api.status.mockResolvedValue({ ...ready, state: "copying" });
  const jobs = new FileCopyJobs(api);
  await jobs.begin(file, "/out/a");
  await jobs.check(1);
  expect(api.status).not.toHaveBeenCalled();
  expect(jobs.getSnapshot()[0].status).toMatchObject({
    state: "unknown",
    settled: true,
  });
  expect(jobs.hasUnsettled()).toBe(false);
});
