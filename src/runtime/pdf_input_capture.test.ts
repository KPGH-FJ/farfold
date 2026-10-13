import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import {
  checkedPdfInputFile,
  decodePdfInputCapture,
  readPdfInputCapture,
} from "./pdf_input_capture";
import { pdfCapture, pdfFixture } from "./pdf_input_fixture.test-support";
beforeEach(() => {
  h.invoke.mockReset();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

it("captures the exact selected seven-field revision and all bytes of a real multi-page PDF", async () => {
  const bytes = await pdfFixture(),
    capture = pdfCapture(bytes);
  h.invoke.mockResolvedValue(capture);
  expect(
    await readPdfInputCapture(capture.file, new AbortController().signal),
  ).toEqual(capture);
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
    "file_delivery_read_pdf_input",
    { file: capture.file },
  );
  expect(
    await decodePdfInputCapture(
      capture.file,
      capture,
      new AbortController().signal,
    ),
  ).toEqual(bytes);
});
it("rejects a changed tail even with unchanged metadata, length and PDF prefix", async () => {
  const bytes = await pdfFixture(),
    capture = pdfCapture(bytes);
  bytes[bytes.length - 10] ^= 1;
  h.invoke.mockResolvedValue({
    ...capture,
    data: Buffer.from(bytes).toString("base64"),
  });
  await expect(
    readPdfInputCapture(capture.file, new AbortController().signal),
  ).rejects.toMatchObject({ code: "changed" });
});
it("does not accept a mismatched source field, extra authority or malformed base64", async () => {
  const capture = pdfCapture(await pdfFixture());
  for (const key of [
    "root",
    "path",
    "resolvedPath",
    "name",
    "version",
    "sha256",
  ] as const) {
    const next = {
      ...capture,
      file: {
        ...capture.file,
        [key]:
          key === "sha256" ? "a".repeat(64) : capture.file[key] + "-changed",
      },
    };
    await expect(
      decodePdfInputCapture(capture.file, next, new AbortController().signal),
    ).rejects.toMatchObject({ code: "changed" });
  }
  for (const value of [
    { ...capture, trusted: true },
    { ...capture, file: { ...capture.file, verified: true } },
    { ...capture, data: capture.data + "\n" },
    { ...capture, data: capture.data.slice(0, -4) },
    { ...capture, data: "=" + capture.data.slice(1) },
    { ...capture, data: capture.data.replace(/.$/, "?") },
  ])
    await expect(
      decodePdfInputCapture(capture.file, value, new AbortController().signal),
    ).rejects.toBeDefined();
});
it("accepts only canonical pad bits and a complete PDF header", async () => {
  const bytes = new TextEncoder().encode("%PDF-a"),
    capture = pdfCapture(bytes);
  const padded = pdfCapture(new TextEncoder().encode("%PDF-"));
  const forged = padded.data.slice(0, -2) + "1="; // same decoded bytes, noncanonical pad bits
  expect(Buffer.from(forged, "base64")).toEqual(
    Buffer.from(padded.data, "base64"),
  );
  await expect(
    decodePdfInputCapture(
      padded.file,
      { ...padded, data: forged },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(
    await decodePdfInputCapture(
      capture.file,
      capture,
      new AbortController().signal,
    ),
  ).toEqual(bytes);
  const wrong = pdfCapture(new TextEncoder().encode("!PDF-a"));
  await expect(
    decodePdfInputCapture(wrong.file, wrong, new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid" });
});
it("retains native actual-read blocking codes and never exposes raw errors", async () => {
  const file = pdfCapture(await pdfFixture()).file;
  for (const code of [
    "readBusy",
    "readPending",
    "limit",
    "changed",
    "invalid",
    "unreadable",
  ]) {
    h.invoke.mockRejectedValue({ code, message: "private diagnostic" });
    await expect(
      readPdfInputCapture(file, new AbortController().signal),
    ).rejects.toMatchObject({ code, message: code });
  }
  h.invoke.mockRejectedValue({ code: "secret", message: "private diagnostic" });
  await expect(
    readPdfInputCapture(file, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unreadable", message: "unreadable" });
});
it("cancels its wait without retrying, stopping an OS read or accepting a late receipt", async () => {
  const capture = pdfCapture(await pdfFixture());
  let finish!: (v: unknown) => void;
  h.invoke.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const abort = new AbortController();
  const pending = expect(
    readPdfInputCapture(capture.file, abort.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  abort.abort();
  await pending;
  finish(capture);
  await Promise.resolve();
  expect(h.invoke).toHaveBeenCalledTimes(1);
  const already = new AbortController();
  already.abort();
  await expect(
    readPdfInputCapture(capture.file, already.signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it("keeps the source limit separate from text and old Office limits", async () => {
  const file = pdfCapture(await pdfFixture()).file;
  expect(checkedPdfInputFile({ ...file, size: 32 * 1024 * 1024 }).size).toBe(
    32 * 1024 * 1024,
  );
  expect(() =>
    checkedPdfInputFile({ ...file, size: 32 * 1024 * 1024 + 1 }),
  ).toThrow("limit");
  expect(() => checkedPdfInputFile({ ...file, size: 4 })).toThrow("limit");
});
