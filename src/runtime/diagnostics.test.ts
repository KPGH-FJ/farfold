import { describe, expect, it, vi } from "vitest";
import { DiagnosticsReview, type DiagnosticPreview } from "./diagnostics";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const preview: DiagnosticPreview = {
  previewId: "reviewed-1",
  generatedAt: "now",
  entries: [{ name: "user-note.txt", text: "issue" }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("diagnostic review and export", () => {
  it("includes the current reminder decision only when preparing the reviewed snapshot", async () => {
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(preview);
    const review = new DiagnosticsReview();
    review.setNote("notification test");
    await review.prepare();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("diagnostics_preview", {
      note: "notification test",
      notification: expect.objectContaining({
        version: 1,
        frontend: expect.objectContaining({ phase: "none", kind: null }),
        backendAttempt: null,
      }),
    });
    vi.mocked(invoke).mockResolvedValueOnce("/Desktop/result.zip");
    await review.export();
    expect(invoke).toHaveBeenLastCalledWith("export_diagnostics", {
      previewId: "reviewed-1",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("requires a real preview and exports its exact id while retaining the note through return paths", async () => {
    const ports = {
      preview: vi.fn(async () => preview),
      export: vi.fn(async () => "/Desktop/result.zip"),
    };
    const review = new DiagnosticsReview(ports);
    review.setNote("issue");
    await review.export();
    expect(ports.export).not.toHaveBeenCalled();
    await review.prepare();
    expect(ports.preview).toHaveBeenCalledWith("issue");
    await review.export();
    expect(ports.export).toHaveBeenCalledExactlyOnceWith("reviewed-1");
    expect(review.getSnapshot()).toMatchObject({
      phase: "done",
      note: "issue",
      path: "/Desktop/result.zip",
    });
    review.showPreview();
    expect(review.getSnapshot().preview).toBe(preview);
    review.edit();
    expect(review.getSnapshot()).toMatchObject({
      phase: "edit",
      note: "issue",
    });
    await review.export();
    expect(ports.export).toHaveBeenCalledTimes(1);
  });
  it("does not install a late preview for a changed issue", async () => {
    const pending = deferred<DiagnosticPreview>();
    const review = new DiagnosticsReview({
      preview: () => pending.promise,
      export: vi.fn(),
    });
    review.setNote("old");
    const opening = review.prepare();
    review.setNote("new");
    pending.resolve(preview);
    await opening;
    expect(review.getSnapshot()).toMatchObject({
      note: "new",
      phase: "edit",
      preview: null,
    });
  });
  it("keeps review content after export failure and ignores repeated export clicks", async () => {
    const pending = deferred<string>();
    const ports = {
      preview: vi.fn(async () => preview),
      export: vi.fn(() => pending.promise),
    };
    const review = new DiagnosticsReview(ports);
    await review.prepare();
    const writing = review.export();
    await review.export();
    review.setNote("cannot replace an in-flight export");
    expect(ports.export).toHaveBeenCalledTimes(1);
    pending.resolve("/Desktop/result.zip");
    await writing;
    expect(review.getSnapshot().note).toBe("");
    const failed = new DiagnosticsReview({
      preview: ports.preview,
      export: async () => {
        throw new Error("预览已过期，请重新预览后再导出");
      },
    });
    failed.setNote("keep this issue");
    await failed.prepare();
    await failed.export();
    expect(failed.getSnapshot()).toMatchObject({
      phase: "preview",
      note: "keep this issue",
      preview,
      path: null,
      error: "预览已过期，请重新预览后再导出",
    });
  });
});
