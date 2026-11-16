import { afterEach, expect, it, vi } from "vitest";
import wire from "../../docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/canonical-wire.json";
import { ConversationArchiveJobs } from "./conversation_archive_jobs";
import type {
  ArchivePort,
  ArchivePrepareInput,
  ArchiveStatus,
} from "./conversation_archive_types";
const input = wire[0].input as ArchivePrepareInput;
const ready = wire[0].ready as ArchiveStatus;
const pending = () => {
  let resolve: (v: unknown) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<unknown>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function setup() {
  const api = {
    file_archive_prepare: vi.fn().mockResolvedValue(ready),
    file_archive_start: vi
      .fn()
      .mockResolvedValue({ ...ready, state: "writing" }),
    file_archive_status: vi
      .fn()
      .mockResolvedValue({ ...ready, state: "writing" }),
    file_archive_cancel: vi
      .fn()
      .mockResolvedValue({ ...ready, state: "cancelled", settled: true }),
    file_archive_release: vi.fn().mockResolvedValue(true),
  };
  return {
    api,
    jobs: new ConversationArchiveJobs(api as ArchivePort, 50, 1000),
  };
}
afterEach(() => vi.useRealTimers());
it("registers exact intent before prepare and starts only the original timely ready once", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup();
  const observations: unknown[] = [];
  jobs.subscribe(() => observations.push(jobs.getSnapshot()[0]?.identity));
  jobs.begin(input);
  expect(jobs.getSnapshot()[0].phase).toBe("preparing");
  await flush();
  expect(api.file_archive_start).toHaveBeenCalledExactlyOnceWith({
    operationId: input.operationId,
    inputSha256: input.inputSha256,
  });
  expect(observations[0]).toMatchObject({ operationId: input.operationId });
  expect(JSON.stringify(jobs.getSnapshot())).not.toContain(input.markdown);
  expect(jobs.hasUnsettled()).toBe(true);
  await jobs.cancel(input.operationId);
  expect(jobs.hasUnsettled()).toBe(false);
});
it("exact cancel can precede pending prepare; its settled receipt wins over late ready and no start occurs", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup(),
    p = pending();
  api.file_archive_prepare.mockReturnValue(p.promise);
  jobs.begin(input);
  await flush();
  await jobs.cancel(input.operationId);
  expect(api.file_archive_cancel).toHaveBeenCalledWith({
    operationId: input.operationId,
    inputSha256: input.inputSha256,
  });
  p.resolve(ready);
  await flush();
  expect(api.file_archive_start).not.toHaveBeenCalled();
  expect(jobs.getSnapshot()[0].reply?.state).toBe("cancelled");
});
it("prepare timeout keeps pending ownership, never grants start to a late ready or status-ready", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup(),
    p = pending();
  api.file_archive_prepare.mockReturnValue(p.promise);
  jobs.begin(input);
  await flush();
  await vi.advanceTimersByTimeAsync(51);
  expect(jobs.getSnapshot()[0].phase).toBe("unconfirmed");
  expect(jobs.hasUnsettled()).toBe(true);
  await jobs.check(input.operationId);
  expect(api.file_archive_status).not.toHaveBeenCalled();
  p.resolve(ready);
  await flush();
  api.file_archive_status.mockResolvedValue(ready);
  await jobs.check(input.operationId);
  expect(api.file_archive_start).not.toHaveBeenCalled();
  await jobs.cancel(input.operationId);
  expect(jobs.hasUnsettled()).toBe(false);
});
it("actual pending start does not block exact cancellation and observing timeout does not settle it", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup(),
    p = pending();
  api.file_archive_start.mockReturnValue(p.promise);
  api.file_archive_cancel.mockResolvedValue({ ...ready, state: "cancelling" });
  jobs.begin(input);
  await flush();
  await vi.advanceTimersByTimeAsync(51);
  await jobs.cancel(input.operationId);
  expect(api.file_archive_cancel).toHaveBeenCalledOnce();
  expect(jobs.hasUnsettled()).toBe(true);
  p.resolve({ ...ready, state: "writing" });
  await flush();
  expect(jobs.getSnapshot()[0].reply?.state).toBe("cancelling");
});
it.each(["late rejection", "invalid reply", "timeout"])(
  "keeps confirmed cancellation when an earlier start returns %s",
  async (outcome) => {
    vi.useFakeTimers();
    const { api, jobs } = setup(),
      start = pending();
    api.file_archive_start.mockReturnValue(start.promise);
    api.file_archive_cancel.mockResolvedValue({
      ...ready,
      state: "cancelling",
    });
    api.file_archive_status.mockResolvedValue({
      ...ready,
      state: "cancelled",
      settled: true,
    });
    jobs.begin(input);
    await flush();
    await jobs.cancel(input.operationId);
    expect(jobs.getSnapshot()[0]).toMatchObject({
      phase: "known",
      reply: { state: "cancelling" },
      code: null,
    });
    if (outcome === "timeout") await vi.advanceTimersByTimeAsync(51);
    else if (outcome === "late rejection")
      start.reject({ code: "unavailable" });
    else start.resolve({ invalid: true });
    await flush();
    expect(jobs.getSnapshot()[0]).toMatchObject({
      phase: "known",
      reply: { state: "cancelling" },
      code: null,
    });
    expect(jobs.hasUnsettled()).toBe(true);
    if (outcome === "timeout") {
      start.resolve({ ...ready, state: "writing" });
      await flush();
    }
    await vi.advanceTimersByTimeAsync(1001);
    expect(api.file_archive_status).toHaveBeenCalledExactlyOnceWith({
      operationId: input.operationId,
      inputSha256: input.inputSha256,
    });
    expect(jobs.getSnapshot()[0].reply?.state).toBe("cancelled");
    expect(jobs.hasUnsettled()).toBe(false);
  },
);
it("bare conflict does not mutate/cancel an existing operation or pretend a terminal result", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup();
  api.file_archive_prepare.mockRejectedValue({ code: "requestConflict" });
  jobs.begin(input);
  await flush();
  expect(jobs.getSnapshot()[0]).toMatchObject({
    phase: "unconfirmed",
    code: "requestConflict",
    reply: null,
  });
  expect(jobs.hasUnsettled()).toBe(true);
  expect(api.file_archive_cancel).not.toHaveBeenCalled();
  expect(api.file_archive_start).not.toHaveBeenCalled();
});
it("same-process absent observation stays unknown; explicit admission closure can be reviewed without historical success", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup();
  api.file_archive_prepare.mockRejectedValue({ code: "unavailable" });
  jobs.begin(input);
  await flush();
  const absent = {
    kind: "conversationArchive",
    operationId: input.operationId,
    inputSha256: input.inputSha256,
    state: "absent",
    settled: true,
    admissionClosed: false,
    result: "unknown",
    scope: "currentProcess",
  };
  api.file_archive_status.mockResolvedValue(absent);
  await jobs.check(input.operationId);
  expect(jobs.hasUnsettled()).toBe(true);
  api.file_archive_cancel.mockResolvedValue({
    ...absent,
    admissionClosed: true,
  });
  await jobs.cancel(input.operationId);
  expect(jobs.hasUnsettled()).toBe(false);
  expect(jobs.hasUnknownFinished()).toBe(true);
  api.file_archive_release.mockResolvedValue(false);
  await jobs.dismiss(input.operationId);
  expect(jobs.getSnapshot()).toHaveLength(1);
  await jobs.dismiss(input.operationId, true);
  expect(jobs.getSnapshot()).toEqual([]);
  expect(api.file_archive_release).not.toHaveBeenCalled();
});
it("completed publication wins over late cancellation and exposes only actual output receipt", async () => {
  vi.useFakeTimers();
  const { api, jobs } = setup(),
    c = pending();
  api.file_archive_cancel.mockReturnValue(c.promise);
  jobs.begin(input);
  await flush();
  void jobs.cancel(input.operationId);
  await flush();
  // This response is from a later explicit status, after cancellation observation expires.
  await vi.advanceTimersByTimeAsync(51);
  c.resolve({
    ...ready,
    state: "completed",
    settled: true,
    publication: "published",
    processedInputBytes: ready.totalInputBytes,
    itemsCompleted: ready.includedCount,
    receipt: {
      kind: "conversationArchive",
      destination: input.destination,
      zipSize: 333,
      zipSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      includedCount: 1,
      omittedCount: 0,
      scope: "selectedLoadedSnapshot",
    },
  });
  await flush();
  expect(jobs.getSnapshot()[0].reply?.state).toBe("completed");
  expect(jobs.hasUnsettled()).toBe(false);
  expect(jobs.hasUnknownFinished()).toBe(false);
});
