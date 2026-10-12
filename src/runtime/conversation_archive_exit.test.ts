import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("./sessions", () => ({
  threads: { getSnapshot: () => ({ threads: new Map() }) },
}));
vi.mock("./authentication", () => ({ hasActiveAuthentication: () => false }));
import wire from "../../docs/evidence/2026-10-09-capability-hardening/attachment-archive/backend/canonical-wire.json";
import { conversationArchiveJobs } from "./conversation_archive_jobs";
import { hasUnsettledFileCopies } from "./file_copy_jobs";
import { exitNeedsReview, hasUnknownFinishedFileCopies } from "./exit_impact";
import type { ArchivePrepareInput } from "./conversation_archive_types";
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
it("real archive observer participates in shared exit protection after its dialog is gone and unknown is not silently released", async () => {
  vi.useFakeTimers();
  const input = wire[0].input as ArchivePrepareInput,
    r = wire[0].ready;
  h.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "file_archive_prepare"
        ? r
        : command === "file_archive_start"
          ? { ...r, state: "writing" }
          : command === "file_archive_cancel"
            ? {
                ...r,
                state: "unknown",
                settled: true,
                publication: "unknown",
                code: "cleanupUnknown",
              }
            : false,
    ),
  );
  expect(exitNeedsReview()).toBe(false);
  conversationArchiveJobs.begin(input);
  expect(hasUnsettledFileCopies()).toBe(true);
  expect(exitNeedsReview()).toBe(true);
  await flush();
  await conversationArchiveJobs.cancel(input.operationId);
  expect(hasUnsettledFileCopies()).toBe(false);
  expect(hasUnknownFinishedFileCopies()).toBe(true);
  expect(exitNeedsReview()).toBe(true);
  await conversationArchiveJobs.dismiss(input.operationId, true);
  expect(exitNeedsReview()).toBe(true);
  expect(conversationArchiveJobs.getSnapshot()[0].closeFailed).toBe(true);
  h.invoke.mockResolvedValue(true);
  await conversationArchiveJobs.dismiss(input.operationId, true);
  expect(conversationArchiveJobs.getSnapshot()).toEqual([]);
  expect(exitNeedsReview()).toBe(false);
});
