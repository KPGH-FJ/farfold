import { afterEach, describe, expect, it, vi } from "vitest";
import { readDocxCapture, readDocxPreview } from "./docx_preview";
import { decodeDocxImages } from "./docx_decode";
import { parseDocx } from "./docx_parse";
import { docxFixture } from "./docx_fixture";
import type { DocxCapture, DocxDocument } from "./docx_types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const file = {
  root: "/fixture",
  path: "/fixture/a.docx",
  resolvedPath: "/fixture/a.docx",
  name: "a.docx",
  sha256: "fixture",
  size: 2000,
  version: "version-a",
};
const input = docxFixture("01-text-values"),
  capture: DocxCapture = { file, ...input, inflatedBytes: 10000 };
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  ready(document: unknown = parseDocx(input)) {
    this.dispatchEvent(
      new MessageEvent("message", { data: { kind: "ready", document } }),
    );
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invoke.mockReset();
  ControlledWorker.instances = [];
});
describe("DOCX capture and exclusive disposable worker", () => {
  it("requires the exact file version and preserves it on successful output", async () => {
    invoke.mockResolvedValue({
      ...capture,
      file: { ...file, version: "other" },
    });
    await expect(
      readDocxCapture(file, new AbortController().signal),
    ).rejects.toMatchObject({ code: "changed" });
    invoke.mockResolvedValue(capture);
    expect(await readDocxCapture(file, new AbortController().signal)).toBe(
      capture,
    );
    vi.stubGlobal("Worker", ControlledWorker);
    const result = readDocxPreview(capture, new AbortController().signal);
    ControlledWorker.instances[0].ready();
    expect((await result).file).toEqual(file);
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });
  it.each([
    "changed",
    "unreadable",
    "encrypted",
    "invalid",
    "limit",
    "unsupported",
    "readPending",
    "readBusy",
  ])("normalizes %s without private text", async (code) => {
    invoke.mockRejectedValue({ code, message: "PRIVATE-ERROR" });
    await expect(
      readDocxCapture(file, new AbortController().signal),
    ).rejects.toMatchObject({ code, message: code });
  });
  it("cancels a pending capture wait without pretending to terminate OS work", async () => {
    let finish: (v: DocxCapture) => void = () => {};
    invoke.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const control = new AbortController(),
      pending = readDocxCapture(file, control.signal);
    control.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    finish(capture);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects pre-abort without IPC or Worker creation", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const control = new AbortController();
    control.abort();
    await expect(readDocxCapture(file, control.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    await expect(
      readDocxPreview(capture, control.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(invoke).not.toHaveBeenCalled();
    expect(ControlledWorker.instances).toHaveLength(0);
  });
  it("blocks concurrent parsing but abort releases immediately and old messages stay old", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const control = new AbortController(),
      first = readDocxPreview(capture, control.signal);
    await expect(
      readDocxPreview(capture, new AbortController().signal),
    ).rejects.toMatchObject({ code: "busy" });
    const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
    control.abort();
    const next = readDocxPreview(capture, new AbortController().signal);
    ControlledWorker.instances[0].ready({ malicious: true });
    ControlledWorker.instances[1].ready();
    await rejected;
    expect((await next).blocks).toHaveLength(6);
  });
  it("deadline and constructor failure both release the worker slot", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", ControlledWorker);
    const result = readDocxPreview(capture, new AbortController().signal),
      rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(ControlledWorker.instances[0].terminate).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw Error("private");
        }
      },
    );
    await expect(
      readDocxPreview(capture, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid" });
    vi.stubGlobal("Worker", ControlledWorker);
    const next = readDocxPreview(capture, new AbortController().signal);
    ControlledWorker.instances[1].ready();
    await next;
  });
  it.each([
    (d: DocxDocument) => ({ ...d, html: "<img src='remote'>" }),
    (d: DocxDocument) => ({
      ...d,
      blocks: [
        {
          kind: "paragraph",
          id: "x",
          style: {},
          runs: [
            { kind: "text", text: "x", style: { background: "url(remote)" } },
          ],
        },
      ],
    }),
    (d: DocxDocument) => ({
      ...d,
      blocks: [
        {
          kind: "paragraph",
          id: "x",
          style: {},
          runs: [
            {
              kind: "image",
              imageId: "missing",
              widthPt: 1,
              heightPt: 1,
              alt: "",
            },
          ],
        },
      ],
    }),
    (d: DocxDocument) => ({ ...d, warnings: [{ code: "unknown", count: 1 }] }),
    (d: DocxDocument) => ({
      ...d,
      blocks: [
        {
          kind: "table",
          id: "x",
          columnsPt: [1],
          rows: [
            { cells: [{ column: 0, columnSpan: 999, rowSpan: 1, blocks: [] }] },
          ],
        },
      ],
    }),
  ])(
    "refuses malformed/unbounded worker structures before exposing them to the UI",
    async (change) => {
      vi.stubGlobal("Worker", ControlledWorker);
      const pending = readDocxPreview(capture, new AbortController().signal);
      ControlledWorker.instances[0].ready(change(parseDocx(input)));
      await expect(pending).rejects.toMatchObject({ code: "invalid" });
    },
  );
});
describe("DOCX actual image decode gate", () => {
  it("requires a decoder when images exist but allows text-only environments", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await expect(
      decodeDocxImages(parseDocx(docxFixture("05-inline-png-jpeg"))),
    ).rejects.toMatchObject({ code: "unsupported" });
    await decodeDocxImages(parseDocx(input));
  });
  it("closes each bitmap before continuing and rejects damaged image payloads", async () => {
    const close = vi.fn(),
      decode = vi.fn().mockResolvedValue({ width: 8, height: 8, close });
    vi.stubGlobal("createImageBitmap", decode);
    await decodeDocxImages(parseDocx(docxFixture("05-inline-png-jpeg")));
    expect(decode).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    decode.mockRejectedValue(Error("codec failure"));
    await expect(
      decodeDocxImages(parseDocx(docxFixture("06-png-pixels-invalid"))),
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("refuses mismatched decoded dimensions and always closes the bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockResolvedValue({ width: 9, height: 8, close }),
    );
    await expect(
      decodeDocxImages(parseDocx(docxFixture("05-inline-png-jpeg"))),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(close).toHaveBeenCalledOnce();
  });
});
