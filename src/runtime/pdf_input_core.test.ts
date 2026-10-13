import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  loading: {} as any,
  pdf: {} as any,
  options: {} as any,
  wrapper: { destroy: vi.fn() },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  VerbosityLevel: { WARNINGS: 1 },
  PDFWorker: { create: vi.fn(() => h.wrapper) },
  getDocument: vi.fn((options) => {
    h.options = options;
    return h.loading;
  }),
}));
import { extractPdfInput } from "./pdf_input_core";
import { pdfRequest } from "./pdf_input_fixture.test-support";
const data = () => new TextEncoder().encode("%PDF-synthetic-control-only");
const port = {} as Worker;
let events: string[], failed: boolean;
const gate = () => ({
  failed: () => failed,
  snapshot: vi.fn(async () => {
    events.push("snapshot");
    return 0;
  }),
});
beforeEach(() => {
  events = [];
  failed = false;
  h.wrapper.destroy
    .mockReset()
    .mockImplementation(() => events.push("wrapper-destroy"));
  h.pdf = {
    numPages: 3,
    isPureXfa: false,
    getPermissions: vi.fn(async () => null),
    getMetadata: vi.fn(async () => ({ info: { IsXFAPresent: false } })),
    getPage: vi.fn(async (number) => {
      let done = false;
      return {
        rotate: number === 2 ? 90 : 0,
        streamTextContent: vi.fn((options) => {
          expect(options).toEqual({
            includeMarkedContent: false,
            disableNormalization: true,
          });
          return {
            getReader: () => ({
              read: async () => {
                if (done) {
                  events.push("page-done-" + number);
                  return { done: true };
                }
                done = true;
                return {
                  done: false,
                  value: {
                    items: [
                      { str: " literal " + number, dir: "ltr", hasEOL: false },
                    ],
                  },
                };
              },
              releaseLock: vi.fn(),
            }),
          };
        }),
        cleanup: vi.fn(),
      };
    }),
  };
  h.loading = {
    promise: Promise.resolve(h.pdf),
    destroy: vi.fn(async () => {
      events.push("loading-destroy");
    }),
  };
});
it("keeps all pages private and observes the official cleanup barrier before the exact-port diagnostic snapshot", async () => {
  const diagnostics = gate();
  const result = await extractPdfInput(
    data(),
    pdfRequest,
    port,
    diagnostics,
    () => false,
  );
  expect(result.scope.readPageNumbers).toEqual([1, 2, 3]);
  expect(result.pages.map((p) => p.items[0].text)).toEqual([
    " literal 1",
    " literal 2",
    " literal 3",
  ]);
  expect(result.pages[1].decodedRotation).toBe(90);
  expect(events).toEqual([
    "page-done-1",
    "page-done-2",
    "page-done-3",
    "loading-destroy",
    "snapshot",
    "wrapper-destroy",
  ]);
  expect(h.loading.destroy).toHaveBeenCalledOnce();
  expect(h.options).toMatchObject({
    enableXfa: false,
    stopAtErrors: false,
    useWorkerFetch: false,
    useWasm: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  });
  expect(h.options).not.toHaveProperty("url");
  expect(h.options).not.toHaveProperty("password");
});
it("does not snapshot or return until destroy actually resolves, and a held late diagnostic invalidates everything", async () => {
  let finish!: () => void;
  h.loading.destroy.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
        events.push("destroy-pending");
      }),
  );
  const diagnostics = gate();
  diagnostics.snapshot.mockResolvedValue(1);
  const pending = expect(
    extractPdfInput(data(), pdfRequest, port, diagnostics, () => false),
  ).rejects.toMatchObject({ code: "incomplete" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(diagnostics.snapshot).not.toHaveBeenCalled();
  expect(h.wrapper.destroy).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(diagnostics.snapshot).toHaveBeenCalledOnce();
  expect(h.wrapper.destroy).toHaveBeenCalledOnce();
});
it("refuses cleanup failure or missing/unreliable diagnostic completion without retry or prefix", async () => {
  h.loading.destroy.mockRejectedValue(new Error("private cleanup error"));
  const diagnostics = gate();
  await expect(
    extractPdfInput(data(), pdfRequest, port, diagnostics, () => false),
  ).rejects.toMatchObject({ code: "incomplete", message: "incomplete" });
  expect(h.loading.destroy).toHaveBeenCalledOnce();
  expect(diagnostics.snapshot).not.toHaveBeenCalled();
  h.loading.destroy.mockResolvedValue(undefined);
  diagnostics.snapshot.mockRejectedValue(new Error("bad fence"));
  await expect(
    extractPdfInput(data(), pdfRequest, port, diagnostics, () => false),
  ).rejects.toMatchObject({ code: "incomplete" });
});
it("refuses parser or local diagnostics even when page promises and cleanup succeed", async () => {
  const diagnostics = gate();
  h.loading.destroy.mockImplementation(async () => {
    failed = true;
  });
  await expect(
    extractPdfInput(data(), pdfRequest, port, diagnostics, () => false),
  ).rejects.toMatchObject({ code: "incomplete" });
  expect(diagnostics.snapshot).not.toHaveBeenCalled();
  failed = false;
  await expect(
    extractPdfInput(data(), pdfRequest, port, gate(), () => true),
  ).rejects.toMatchObject({ code: "incomplete" });
});
it.each([new Set(), new Set([4])])(
  "rejects any nonnull encryption permissions without copying text",
  async (permissions) => {
    h.pdf.getPermissions.mockResolvedValue(permissions);
    await expect(
      extractPdfInput(data(), pdfRequest, port, gate(), () => false),
    ).rejects.toMatchObject({ code: "encrypted" });
    expect(h.pdf.getPage).not.toHaveBeenCalled();
    expect(h.loading.destroy).toHaveBeenCalledOnce();
  },
);
it("rejects password requests without supplying, asking for or persisting a password", async () => {
  h.loading.promise = new Promise(() => {});
  const pending = expect(
    extractPdfInput(data(), pdfRequest, port, gate(), () => false),
  ).rejects.toMatchObject({ code: "encrypted" });
  await vi.waitFor(() => expect(h.loading.onPassword).toBeTypeOf("function"));
  const answer = vi.fn();
  h.loading.onPassword(answer, 1);
  await pending;
  expect(answer).not.toHaveBeenCalled();
  expect(h.loading.destroy).toHaveBeenCalledOnce();
});
it.each([{}, { IsXFAPresent: true }, { IsXFAPresent: "false" }, null])(
  "refuses saved XFA or unverifiable XFA facts despite isPureXfa=false: %j",
  async (info) => {
    h.pdf.getMetadata.mockResolvedValue({ info });
    await expect(
      extractPdfInput(data(), pdfRequest, port, gate(), () => false),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(h.pdf.getPage).not.toHaveBeenCalled();
  },
);
it("does not silently fall back to a same-thread parser or exceed the whole document page bound", async () => {
  await expect(
    extractPdfInput(
      data(),
      pdfRequest,
      undefined as never,
      gate(),
      () => false,
    ),
  ).rejects.toMatchObject({ code: "unsupported" });
  h.pdf.numPages = 1001;
  await expect(
    extractPdfInput(data(), pdfRequest, port, gate(), () => false),
  ).rejects.toMatchObject({ code: "limit" });
  expect(h.pdf.getPage).not.toHaveBeenCalled();
});
