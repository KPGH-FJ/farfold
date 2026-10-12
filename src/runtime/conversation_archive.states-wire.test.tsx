import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({ get: () => [] as unknown[] }));
vi.mock("./conversation_archive_jobs", async (original) => ({
  ...(await original<typeof import("./conversation_archive_jobs")>()),
  useConversationArchiveJobs: () => h.get(),
}));
import wire from "../../docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/actual-wire.json";
import { archiveCanonical, archiveInput } from "./conversation_archive_input";
import { parseArchiveReply } from "./conversation_archive_parse";
import { ConversationArchiveJobs } from "./conversation_archive_jobs";
import { ConversationArchiveJobsStatus } from "../components/ConversationArchiveJobsStatus";
import type {
  ArchiveIdentity,
  ArchivePrepareInput,
  ArchivePort,
  ArchiveRequestKey,
} from "./conversation_archive_types";
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  h.get = () => [];
});
it.each(wire.canonical.map((value, index) => ({ value, index })))(
  "preserves final actual Rust canonical bytes and SHA $index",
  async ({ value }) => {
    const input = value.input as ArchivePrepareInput;
    expect(archiveCanonical(input)).toBe(value.canonical);
    expect((await archiveInput(input)).inputSha256).toBe(value.sha256);
  },
);
it.each(Object.entries(wire.states))(
  "strictly accepts actual Rust state %s unchanged",
  (_name, value) => {
    expect(
      parseArchiveReply(value, value as ArchiveIdentity | ArchiveRequestKey),
    ).toEqual(value);
  },
);
async function requestFor(actual: {
  operationId: string;
  destination: string;
  inputSha256: string;
}) {
  // The Rust jobs use canonical sample 0 with their own temporary destination.
  // Require its complete canonical input hash before replaying unchanged replies.
  const input = await archiveInput({
    ...(wire.canonical[0].input as ArchivePrepareInput),
    operationId: actual.operationId,
    destination: actual.destination,
  });
  expect(input.inputSha256).toBe(actual.inputSha256);
  return input;
}
it("replays actual ready/writing/publishing/completed through real jobs and status rendering without assuming progress is completion", async () => {
  vi.useFakeTimers();
  const s = wire.states,
    input = await requestFor(s.ready);
  const api = {
    file_archive_prepare: vi.fn().mockResolvedValue(s.ready),
    file_archive_start: vi.fn().mockResolvedValue(s.writing),
    file_archive_status: vi
      .fn()
      .mockResolvedValueOnce(s.publishing)
      .mockResolvedValueOnce(s.completed),
    file_archive_cancel: vi.fn(),
    file_archive_release: vi.fn().mockResolvedValue(true),
  };
  const jobs = new ConversationArchiveJobs(api as ArchivePort);
  h.get = jobs.getSnapshot;
  jobs.begin(input);
  await flush();
  expect(jobs.getSnapshot()[0].reply).toEqual(s.writing);
  await jobs.check(input.operationId);
  expect(jobs.hasUnsettled()).toBe(true);
  expect(renderToStaticMarkup(<ConversationArchiveJobsStatus />)).not.toContain(
    "已保存本次所选内容",
  );
  await jobs.check(input.operationId);
  expect(jobs.getSnapshot()[0].reply).toEqual(s.completed);
  expect(jobs.hasUnsettled()).toBe(false);
  const html = renderToStaticMarkup(<ConversationArchiveJobsStatus />);
  expect(html).toContain("已保存本次所选内容");
  expect(html).toContain(s.completed.receipt.zipSha256);
  expect(html).not.toContain("完成保存仍需等待");
  expect(html).not.toContain(input.markdown);
  await jobs.dismiss(input.operationId);
});
it("an actual finished-unknown status retains explicit review rather than treating cancelled or complete as implied", async () => {
  vi.useFakeTimers();
  const s = wire.states,
    input = await requestFor(s.unknown);
  const api = {
    file_archive_prepare: vi.fn().mockRejectedValue({ code: "unavailable" }),
    file_archive_start: vi.fn(),
    file_archive_status: vi.fn().mockResolvedValue(s.unknown),
    file_archive_cancel: vi.fn(),
    file_archive_release: vi.fn().mockResolvedValue(true),
  };
  const jobs = new ConversationArchiveJobs(api as ArchivePort);
  h.get = jobs.getSnapshot;
  jobs.begin(input);
  await flush();
  await jobs.check(input.operationId);
  expect(jobs.getSnapshot()[0].reply).toEqual(s.unknown);
  expect(jobs.hasUnsettled()).toBe(false);
  expect(jobs.hasUnknownFinished()).toBe(true);
  expect(api.file_archive_start).not.toHaveBeenCalled();
  const html = renderToStaticMarkup(<ConversationArchiveJobsStatus />);
  expect(html).toContain("结果尚未确认");
  expect(html).not.toContain("已保存本次所选内容");
  expect(html).not.toContain("已取消保存。");
  await jobs.dismiss(input.operationId);
  expect(jobs.getSnapshot()).toHaveLength(1);
  await jobs.dismiss(input.operationId, true);
  expect(jobs.getSnapshot()).toEqual([]);
});
it("zero selected bytes remains ready until actual published receipt, not a numeric progress inference", () => {
  const s = wire.states;
  expect(
    parseArchiveReply(s.zeroReady, s.zeroReady as ArchiveIdentity).state,
  ).toBe("ready");
  expect(s.zeroReady.totalInputBytes).toBe(0);
  expect(
    parseArchiveReply(s.zeroCompleted, s.zeroReady as ArchiveIdentity).state,
  ).toBe("completed");
});
