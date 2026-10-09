import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FileRevisionMonitor,
  type RevisionTarget,
  type RevisionNotice,
} from "./file_revision_monitor";
import type { FileRevisionCheck, VerifiedFile } from "./file_delivery";

const file = {
  root: "/work",
  path: "/work/a.txt",
  resolvedPath: "/work/a.txt",
  name: "a.txt",
  size: 3,
  sha256: "one",
  version: "one",
};
let target: RevisionTarget;
let monitor: FileRevisionMonitor;
let check: ReturnType<
  typeof vi.fn<
    (file: VerifiedFile, mode: "hint" | "content") => Promise<FileRevisionCheck>
  >
>;
let apply: ReturnType<
  typeof vi.fn<
    (
      file: VerifiedFile,
      valid: () => boolean,
    ) => Promise<"applied" | "deferred" | "failed">
  >
>;
let notice: ReturnType<typeof vi.fn<(value: RevisionNotice | null) => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  target = { identity: "selected", file, enabled: true, blocked: false };
  check = vi.fn(async () => ({ kind: "hintUnchanged" as const }));
  apply = vi.fn(async () => "applied" as const);
  notice = vi.fn();
  monitor = new FileRevisionMonitor({ check, apply, notice });
  monitor.update(target);
});
afterEach(() => {
  monitor.dispose();
  vi.useRealTimers();
});

it("checks metadata cheaply and fully rechecks at a bounded cadence", async () => {
  await vi.advanceTimersByTimeAsync(60000);
  expect(check).toHaveBeenCalledTimes(12);
  expect(check.mock.calls.slice(0, 11).every((c) => c[1] === "hint")).toBe(
    true,
  );
  expect(check.mock.calls[11][1]).toBe("content");
  expect(apply).not.toHaveBeenCalled();
});
it("does not rerender an unchanged full receipt", async () => {
  check.mockResolvedValue({ kind: "verified", file: { ...file } });
  monitor.focus();
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledWith(file, "content");
  expect(apply).not.toHaveBeenCalled();
});
it("applies a fully verified changed version once", async () => {
  const next = { ...file, version: "two", sha256: "two" };
  check.mockResolvedValue({ kind: "verified", file: next });
  apply.mockImplementation(async () => {
    monitor.update({ ...target, file: next });
    return "applied";
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(notice).not.toHaveBeenCalledWith("refreshFailed");
});
it("keeps one in-flight read across focus, hide, and reactivation", async () => {
  let resolve!: (value: FileRevisionCheck) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  monitor.update({ ...target, enabled: false });
  monitor.update(target);
  monitor.focus();
  await vi.advanceTimersByTimeAsync(120000);
  expect(check).toHaveBeenCalledTimes(1);
  resolve({ kind: "verified", file: { ...file, version: "old-result" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(apply).not.toHaveBeenCalled();
  expect(check).toHaveBeenCalledTimes(2);
  expect(check.mock.calls[1][1]).toBe("content");
});
it("retains pending failure while hidden and does not retry on focus", async () => {
  let reject!: (error: unknown) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  monitor.update({ ...target, enabled: false });
  reject({ code: "pending" });
  await vi.advanceTimersByTimeAsync(0);
  monitor.update(target);
  monitor.focus();
  await vi.advanceTimersByTimeAsync(120000);
  expect(check).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenLastCalledWith("pending");
});
it("does not deliver another selected file's late error", async () => {
  let reject!: (error: unknown) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  monitor.update({
    ...target,
    identity: "other",
    file: { ...file, path: "/work/b.txt" },
  });
  reject({ code: "missing" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(notice).not.toHaveBeenCalledWith("missing");
  expect(check).toHaveBeenCalledTimes(2);
});
it("stops when editing requires retaining the displayed version", async () => {
  check.mockResolvedValue({
    kind: "verified",
    file: { ...file, version: "new" },
  });
  apply.mockResolvedValue("deferred");
  await vi.advanceTimersByTimeAsync(120000);
  expect(check).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenLastCalledWith("newVersion");
});
it("stops on refresh failure until an explicitly reloaded receipt arrives", async () => {
  check.mockResolvedValue({
    kind: "verified",
    file: { ...file, version: "new" },
  });
  apply.mockResolvedValue("failed");
  await vi.advanceTimersByTimeAsync(120000);
  expect(check).toHaveBeenCalledTimes(1);
  expect(notice).toHaveBeenLastCalledWith("refreshFailed");
  monitor.update({ ...target, file: { ...file } });
  await vi.advanceTimersByTimeAsync(5000);
  expect(check).toHaveBeenCalledTimes(2);
});
it("pauses checks in a hidden window and rechecks content on return", async () => {
  monitor.setVisible(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(check).not.toHaveBeenCalled();
  monitor.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledWith(file, "content");
});
it("never overlaps a user-owned file operation", async () => {
  monitor.update({ ...target, blocked: true });
  await vi.advanceTimersByTimeAsync(60000);
  expect(check).not.toHaveBeenCalled();
  monitor.update(target);
  await vi.advanceTimersByTimeAsync(5000);
  expect(check).toHaveBeenCalledTimes(1);
});
it("does not publish or restart after disposal", async () => {
  let resolve!: (value: FileRevisionCheck) => void;
  check.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  monitor.dispose();
  resolve({ kind: "verified", file: { ...file, version: "new" } });
  await vi.advanceTimersByTimeAsync(60000);
  expect(check).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
});
