import { afterEach, expect, it, vi } from "vitest";
import { FileCopyJobs } from "./file_copy_jobs";
import type { CopyStatus } from "./file_copy_types";

const file = {
  root: "/controlled",
  path: "/controlled/source.txt",
  resolvedPath: "/controlled/source.txt",
  name: "source.txt",
  size: 6,
  version: "source-v1",
  sha256: "controlled-digest",
};
const destination = "/controlled-output/copy.txt";
const ready: CopyStatus = {
  operationId: "independent-copy",
  file,
  destination,
  state: "ready",
  settled: false,
  bytesCopied: 0,
  total: file.size,
};

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function portFor(prepare: Promise<unknown>) {
  return {
    prepare: vi.fn().mockReturnValue(prepare),
    start: vi.fn(),
    status: vi.fn(),
    cancel: vi
      .fn()
      .mockResolvedValue({ ...ready, state: "cancelled", settled: true }),
    release: vi.fn().mockResolvedValue(true),
  };
}

it("withdraws a never-settled preparation without permanently trapping exit", async () => {
  vi.useFakeTimers();
  const pending = deferred<unknown>();
  const port = portFor(pending.promise);
  const jobs = new FileCopyJobs(port);
  const begin = jobs.begin(file, destination);
  expect(jobs.hasUnsettled()).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  await begin;
  expect(port.start).not.toHaveBeenCalled();
  expect(jobs.getSnapshot()[0].phase).toBe("notStarted");
  expect(jobs.hasUnsettled()).toBe(false);
  await jobs.dismiss(jobs.getSnapshot()[0].id);
  expect(jobs.getSnapshot()).toEqual([]);
});

it("cancels the precise late ready reservation even after its withdrawn card closed", async () => {
  vi.useFakeTimers();
  const pending = deferred<unknown>();
  const port = portFor(pending.promise);
  const jobs = new FileCopyJobs(port);
  const begin = jobs.begin(file, destination);
  await vi.advanceTimersByTimeAsync(10_000);
  await begin;
  await jobs.dismiss(jobs.getSnapshot()[0].id);
  expect(jobs.getSnapshot()).toEqual([]);
  pending.resolve(ready);
  await vi.advanceTimersByTimeAsync(0);
  expect(port.start).not.toHaveBeenCalled();
  expect(port.cancel).toHaveBeenCalledTimes(1);
  expect(port.cancel).toHaveBeenCalledWith(ready.operationId);
  expect(jobs.hasUnsettled()).toBe(false);
});

it.each(["copying", "publishing", "completed"] as const)(
  "never publishes a %s prepare reply as evidence that a writer was started",
  async (state) => {
    vi.useFakeTimers();
    const unexpected: CopyStatus = {
      ...ready,
      state,
      ...(state === "completed"
        ? {
            settled: true,
            bytesCopied: file.size,
            receipt: {
              kind: "fileCopy" as const,
              destination,
              size: file.size,
              sha256: file.sha256,
              sourceVersion: file.version,
            },
          }
        : {}),
    };
    const port = {
      prepare: vi.fn().mockResolvedValue(unexpected),
      start: vi.fn().mockResolvedValue({ ...ready, state: "copying" }),
      status: vi.fn().mockResolvedValue(ready),
      cancel: vi
        .fn()
        .mockResolvedValue({ ...ready, state: "cancelled", settled: true }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const jobs = new FileCopyJobs(port);
    const published: Array<string | undefined> = [];
    const unsubscribe = jobs.subscribe(() => {
      published.push(jobs.getSnapshot()[0]?.status?.state);
    });
    try {
      await jobs.begin(file, destination);
      expect(port.start).not.toHaveBeenCalled();
      expect(published).not.toContain(state);
      expect(jobs.getSnapshot()[0].phase).toBe("notStarted");
      expect(jobs.hasUnsettled()).toBe(false);
      await jobs.dismiss(jobs.getSnapshot()[0].id);
      expect(jobs.getSnapshot()).toEqual([]);
    } finally {
      unsubscribe();
    }
  },
);

it("treats exact-ID absence as no current IO but never as historical success", async () => {
  vi.useFakeTimers();
  const lateStart = deferred<unknown>();
  const port = portFor(Promise.resolve(ready));
  port.start.mockReturnValue(lateStart.promise);
  port.status.mockResolvedValue({
    operationId: ready.operationId,
    absent: true,
    settled: true,
  });
  const jobs = new FileCopyJobs(port);
  const begin = jobs.begin(file, destination);
  await vi.advanceTimersByTimeAsync(10_000);
  await begin;
  const id = jobs.getSnapshot()[0].id;
  expect(jobs.hasUnsettled()).toBe(true);
  await jobs.check(id);
  expect(jobs.getSnapshot()[0]).toMatchObject({
    phase: "uncertain",
    absence: true,
  });
  expect(jobs.hasUnsettled()).toBe(false);
  expect(jobs.getSnapshot()[0].status?.state).toBe("ready");
  await jobs.dismiss(id);
  expect(jobs.getSnapshot()).toHaveLength(1);
  await jobs.cancel(id);
  await jobs.check(id);
  lateStart.resolve({ ...ready, state: "copying" });
  await vi.advanceTimersByTimeAsync(0);
  expect(jobs.getSnapshot()[0].absence).toBe(true);
  expect(port.start).toHaveBeenCalledTimes(1);
  expect(port.status).toHaveBeenCalledTimes(1);
  expect(port.cancel).not.toHaveBeenCalled();
  await jobs.dismiss(id, true);
  expect(jobs.getSnapshot()).toEqual([]);
  expect(port.release).not.toHaveBeenCalled();
});

it.each([
  null,
  { operationId: "another-copy", absent: true, settled: true },
  { operationId: ready.operationId, absent: true, settled: false },
  {
    operationId: ready.operationId,
    absent: true,
    settled: true,
    state: "completed",
  },
])(
  "does not infer no IO from malformed or wrong-owner absence %j",
  async (reply) => {
    vi.useFakeTimers();
    const port = portFor(Promise.resolve(ready));
    port.start.mockRejectedValue(new Error("controlled lost reply"));
    port.status.mockResolvedValue(reply);
    const jobs = new FileCopyJobs(port);
    await jobs.begin(file, destination);
    const id = jobs.getSnapshot()[0].id;
    await jobs.check(id);
    expect(jobs.hasUnsettled()).toBe(true);
    expect(jobs.getSnapshot()[0].absence).toBeUndefined();
    await jobs.dismiss(id, true);
    expect(jobs.getSnapshot()).toHaveLength(1);
    port.status.mockRejectedValue(new Error("controlled unavailable bridge"));
    await jobs.check(id);
    expect(jobs.hasUnsettled()).toBe(true);
    expect(port.start).toHaveBeenCalledTimes(1);
  },
);
