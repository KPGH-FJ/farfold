import { expect, it, vi } from "vitest";
import { FileCopyJobs } from "./file_copy_jobs";
import { deferred, flush } from "./session_tools.test-support";

const source = {
  root: "/source",
  path: "/source/original.txt",
  resolvedPath: "/source/original.txt",
  name: "original.txt",
  size: 6,
  sha256: "a".repeat(64),
  version: "source-version",
};
const saved = {
  root: "/real-output",
  path: "/selected-output/copy.txt",
  resolvedPath: "/real-output/copy.txt",
  name: "copy.txt",
  size: 6,
  sha256: source.sha256,
  version: "published-copy-version",
};
async function fixture(destinationFile: unknown = saved) {
  const ready = {
    operationId: "copy-op",
    file: source,
    destination: saved.path,
    state: "ready",
    settled: false,
    bytesCopied: 0,
    total: 6,
  };
  const completed = {
    ...ready,
    state: "completed",
    settled: true,
    bytesCopied: 6,
    receipt: {
      kind: "fileCopy",
      destination: saved.path,
      size: 6,
      sha256: source.sha256,
      sourceVersion: source.version,
      ...(destinationFile === undefined ? {} : { destinationFile }),
    },
  };
  const copy = {
    prepare: vi.fn().mockResolvedValue(ready),
    start: vi.fn().mockResolvedValue(completed),
    status: vi.fn(),
    cancel: vi.fn(),
    release: vi.fn().mockResolvedValue(true),
  };
  const files = {
    inspectSelected: vi.fn().mockResolvedValue({ ...saved }),
    open: vi.fn().mockResolvedValue(undefined),
    reveal: vi.fn().mockResolvedValue(undefined),
  };
  const jobs = new FileCopyJobs(copy, 800, 10_000, files);
  await jobs.begin(source, saved.path);
  return { jobs, copy, files, completed };
}

it.each(["open", "reveal"] as const)(
  "%s uses only the saved destination and freshly checked full identity, including valid parent aliases",
  async (kind) => {
    const h = await fixture();
    await h.jobs.actOnSavedCopy(1, kind, () => true);
    expect(h.files.inspectSelected).toHaveBeenCalledExactlyOnceWith(saved.path);
    expect(h.files[kind]).toHaveBeenCalledExactlyOnceWith(saved);
    expect(h.files[kind].mock.calls[0][0]).not.toBe(saved);
    expect(h.jobs.getSnapshot()[0].status?.state).toBe("completed");
    expect(h.copy.start).toHaveBeenCalledOnce();
  },
);

it.each([
  { ...saved, version: "replacement-same-bytes" },
  { ...saved, root: "/redirected", resolvedPath: "/redirected/copy.txt" },
  { ...saved, resolvedPath: source.resolvedPath, version: source.version },
  { ...saved, path: "/different-request/copy.txt" },
  { ...saved, sha256: "b".repeat(64) },
  { ...saved, extra: "unexpected" },
  null,
])(
  "rejects changed, redirected or malformed fresh target %j without altering copy success",
  async (actual) => {
    const h = await fixture();
    h.files.inspectSelected.mockResolvedValue(actual);
    await h.jobs.actOnSavedCopy(1, "open", () => true);
    expect(h.files.open).not.toHaveBeenCalled();
    expect(h.files.reveal).not.toHaveBeenCalled();
    expect(h.jobs.getSnapshot()[0]).toMatchObject({
      phase: "known",
      status: { state: "completed" },
      savedAction: { code: "changed", pending: false },
    });
  },
);

it("does not offer actions for legacy receipts or a malformed published identity", async () => {
  for (const field of [
    undefined,
    { ...saved, path: "/wrong" },
    { ...saved, version: "" },
  ]) {
    const h = await fixture(field);
    if (field === undefined)
      delete h.jobs.getSnapshot()[0].status!.receipt!.destinationFile;
    await h.jobs.actOnSavedCopy(1, "open", () => true);
    expect(h.files.inspectSelected).not.toHaveBeenCalled();
  }
});

it("admits only one explicit action across views while an inspection is pending", async () => {
  const h = await fixture(),
    wait = deferred();
  h.files.inspectSelected.mockReturnValue(wait.promise);
  const first = h.jobs.actOnSavedCopy(1, "open", () => true);
  const second = h.jobs.actOnSavedCopy(1, "reveal", () => true);
  await flush();
  expect(h.jobs.getSnapshot()[0].savedAction?.pending).toBe(true);
  expect(h.files.inspectSelected).toHaveBeenCalledOnce();
  wait.resolve(saved);
  await Promise.all([first, second]);
  expect(h.files.open).toHaveBeenCalledOnce();
  expect(h.files.reveal).not.toHaveBeenCalled();
});

it.each(["dismiss", "view", "receipt"])(
  "a %s change while inspecting prevents a late native action",
  async (reason) => {
    const h = await fixture(),
      wait = deferred();
    let interest = true;
    h.files.inspectSelected.mockReturnValue(wait.promise);
    const result = h.jobs.actOnSavedCopy(1, "open", () => interest);
    await flush();
    if (reason === "dismiss") await h.jobs.dismiss(1);
    else if (reason === "view") interest = false;
    else
      h.jobs.getSnapshot()[0].status!.receipt!.destinationFile!.version =
        "different";
    wait.resolve(saved);
    await result;
    expect(h.files.open).not.toHaveBeenCalled();
    expect(h.files.reveal).not.toHaveBeenCalled();
  },
);

it("native final revalidation refusal preserves the successful receipt and never falls back", async () => {
  const h = await fixture();
  h.files.open.mockRejectedValue("文件或位置已变化，请重新检查");
  await h.jobs.actOnSavedCopy(1, "open", () => true);
  expect(h.files.reveal).not.toHaveBeenCalled();
  expect(h.jobs.getSnapshot()[0]).toMatchObject({
    status: { state: "completed" },
    savedAction: { code: "changed", pending: false },
  });
});

it("pending reads do not open, automatically retry or change the completed copy", async () => {
  const h = await fixture();
  h.files.inspectSelected.mockRejectedValue(
    "文件检查尚未返回，后台可能仍在检查。请查看系统访问提示；仍无响应时，保存工作后退出重开。",
  );
  await h.jobs.actOnSavedCopy(1, "reveal", () => true);
  expect(h.files.open).not.toHaveBeenCalled();
  expect(h.files.reveal).not.toHaveBeenCalled();
  expect(h.files.inspectSelected).toHaveBeenCalledOnce();
  expect(h.jobs.getSnapshot()[0]).toMatchObject({
    status: { state: "completed" },
    savedAction: { code: "pending", pending: false },
  });
});

it("inactive interest cannot inspect, and a later native rejection cannot replace another record's state", async () => {
  const h = await fixture();
  await h.jobs.actOnSavedCopy(1, "open", () => false);
  expect(h.files.inspectSelected).not.toHaveBeenCalled();
  const native = deferred();
  h.files.open.mockReturnValue(native.promise);
  const first = h.jobs.actOnSavedCopy(1, "open", () => true);
  await flush();
  await h.jobs.dismiss(1);
  native.reject("PRIVATE native error");
  await first;
  expect(h.jobs.getSnapshot()).toEqual([]);
  expect(h.files.open).toHaveBeenCalledOnce();
  expect(h.files.reveal).not.toHaveBeenCalled();
});
