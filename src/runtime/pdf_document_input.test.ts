import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), parse: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
// This unit tests the common boundary and real whole-byte capture. It does not
// claim Worker/parser accuracy; those require the separate actual Worker gate.
vi.mock("./pdf_input_read", () => ({ readPdfInput: h.parse }));
import {
  confirmDocumentInput,
  readDocumentInput,
  verifyDocumentInput,
  type DocumentInputOptions,
} from "./document_input";
import { localResourcePath, type VerifiedFile } from "./file_delivery";
import { filePathUri } from "./file_paths";
import {
  PDF_INPUT_SCOPE_WARNING_CODES,
  PdfInputError,
  type PdfInputRequest,
  type PdfInputResult,
} from "./pdf_input_types";
const request: PdfInputRequest = {
  mode: "decoded-page-text",
  includePossiblyInvisibleText: true,
};
const fixture = new URL(
  "./fixtures/pdf-input/01-pages-hidden-crop-ocr.pdf",
  import.meta.url,
);
let directory: string, path: string, uri: string;
function receipt(): VerifiedFile {
  const data = readFileSync(path),
    sha256 = createHash("sha256").update(data).digest("hex");
  return {
    root: directory,
    path,
    resolvedPath: path,
    name: basename(path),
    size: data.length,
    sha256,
    version: `unit:${sha256}`,
  };
}
function result(): PdfInputResult {
  return {
    scope: {
      ...request,
      pageCount: 3,
      readPageNumbers: [1, 2, 3],
      extraction: "pdfjs-text-content-v1",
    },
    pages: [1, 2, 3].map((number) => ({
      number,
      decodedRotation: 0,
      items: [{ text: `WHOLE_PAGE_${number} 😀`, dir: "ltr", hasEOL: true }],
    })),
    partial: true,
    warnings: PDF_INPUT_SCOPE_WARNING_CODES.map((code) => ({
      code,
      count: 1,
      unit: "scope",
    })),
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "farfold-pdf-common-unit-"));
  path = join(directory, "chosen.pdf");
  uri = filePathUri(path);
  path = localResourcePath(uri)!;
  writeFileSync(path, readFileSync(fixture));
  vi.stubGlobal("crypto", webcrypto);
  h.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "file_delivery_inspect_selected") {
      expect(args.path).toBe(path);
      return receipt();
    }
    if (command === "file_delivery_read_pdf_input") {
      expect(args.file).toEqual(receipt());
      return { file: receipt(), data: readFileSync(path).toString("base64") };
    }
    if (command === "file_delivery_check_revision") {
      expect(args.mode).toBe("content");
      return { kind: "verified", file: receipt() };
    }
    throw new Error(`unexpected unit command ${command}`);
  });
  h.parse.mockReset().mockImplementation(async (capture, scope) => {
    expect(capture.file).toEqual(receipt());
    const bytes = Buffer.from(capture.data, "base64");
    expect(bytes.length).toBe(receipt().size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      receipt().sha256,
    );
    expect(scope).toEqual(request);
    return result();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
const read = (
  options: DocumentInputOptions | undefined = { pdf: request },
  signal = new AbortController().signal,
) => readDocumentInput({ uri, name: "chosen.pdf" }, signal, options);
const approve = async () =>
  confirmDocumentInput(await read(), { partialSelected: true });
describe("PDF common explicit scope/source boundary", () => {
  it.each(["opaque-document", "renamed.txt"])(
    "explicit PDF choice rereads %s by whole signature, retaining original cold scope",
    async (name) => {
      path = join(directory, name);
      uri = filePathUri(path);
      path = localResourcePath(uri)!;
      writeFileSync(path, readFileSync(fixture));
      const approved = await approve();
      expect(approved.local).toMatchObject({
        format: "pdf",
        source: receipt(),
        scope: result().scope,
      });
      const original = structuredClone(approved);
      await verifyDocumentInput(approved, uri, { reparse: true });
      expect(h.parse).toHaveBeenCalledTimes(2);
      expect(h.parse.mock.calls[1][1]).toEqual(request);
      expect(approved).toEqual(original);
      expect(
        h.invoke.mock.calls.every(
          ([command]) =>
            command !== "draft_attachment_check" &&
            command !== "session_prompt",
        ),
      ).toBe(true);
    },
  );
  it("an opaque PDF scope omission is rejected before inspecting any file", async () => {
    path = join(directory, "opaque-document");
    uri = filePathUri(path);
    path = localResourcePath(uri)!;
    writeFileSync(path, readFileSync(fixture));
    await expect(read({ pdf: undefined })).rejects.toMatchObject({
      code: "scopeRequired",
    });
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.parse).not.toHaveBeenCalled();
  });
  it("explicit PDF selection rejects non-PDF whole bytes before parser or ordinary text fallback", async () => {
    path = join(directory, "opaque-document");
    uri = filePathUri(path);
    path = localResourcePath(uri)!;
    writeFileSync(
      path,
      "ordinary text must never replace retained document text",
    );
    await expect(read()).rejects.toMatchObject({ code: "invalid" });
    expect(h.parse).not.toHaveBeenCalled();
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "file_delivery_inspect_selected",
      "file_delivery_read_pdf_input",
    ]);
  });
  it.each([
    undefined,
    {},
    { pdf: { mode: "decoded-page-text", includePossiblyInvisibleText: false } },
  ])(
    "requires explicit invisible-text selection before any file I/O (%j)",
    async (options) => {
      await expect(
        readDocumentInput(
          { uri, name: "chosen.pdf" },
          new AbortController().signal,
          options as DocumentInputOptions,
        ),
      ).rejects.toMatchObject({ code: "scopeRequired" });
      expect(h.invoke).not.toHaveBeenCalled();
      expect(h.parse).not.toHaveBeenCalled();
    },
  );
  it.each([
    { pdf: request, xlsx: { mode: "visible-saved-cells" } },
    { xlsx: { mode: "all-saved-cells" } },
    { pdf: { ...request, extra: true } },
    { pdf: { ...request, mode: "preview" } },
    { pdf: request, extra: true },
  ])("rejects mixed/unknown options before I/O (%j)", async (options) => {
    await expect(read(options as DocumentInputOptions)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("captures whole real PDF bytes, then requires distinct partial confirmation and live source verification", async () => {
    const review = await read();
    expect(review.text).toContain("WHOLE_PAGE_3");
    expect(review.local).toMatchObject({
      format: "pdf",
      scope: result().scope,
      partial: true,
      partialSelected: false,
      source: receipt(),
    });
    await expect(
      confirmDocumentInput(review, { partialSelected: false }),
    ).rejects.toMatchObject({ code: "invalid" });
    const approved = await confirmDocumentInput(review, {
      partialSelected: true,
    });
    expect(approved.local?.textSha256).toBe(
      createHash("sha256").update(approved.text).digest("hex"),
    );
    const old = structuredClone(approved);
    const parses = h.parse.mock.calls.length;
    await verifyDocumentInput(approved, uri);
    expect(h.parse).toHaveBeenCalledTimes(parses);
    expect(approved).toEqual(old);
    expect(
      h.invoke.mock.calls.every(
        ([command]) => !String(command).startsWith("session_"),
      ),
    ).toBe(true);
  });
  it("explicit cold review reparses original whole scope without modifying input or sending", async () => {
    const approved = await approve(),
      before = structuredClone(approved);
    await verifyDocumentInput(approved, uri, { reparse: true });
    expect(h.parse).toHaveBeenCalledTimes(2);
    expect(h.parse.mock.calls[1][1]).toEqual(request);
    expect(approved).toEqual(before);
    expect(
      h.invoke.mock.calls.some(([command]) => command === "session_prompt"),
    ).toBe(false);
  });
  it.each(["scope", "warnings", "text"])(
    "cold review rejects altered %s despite unchanged whole source",
    async (field) => {
      const approved = await approve(),
        before = structuredClone(approved);
      const changed = result();
      if (field === "scope") {
        changed.scope.pageCount = 2;
        changed.scope.readPageNumbers.pop();
        changed.pages.pop();
      }
      if (field === "warnings") {
        changed.pages[2].items = [];
        changed.warnings.push({
          code: "pagesWithoutText",
          count: 1,
          unit: "pages",
        });
      }
      if (field === "text")
        changed.pages[2].items[0].text = "REPLACED_LATE_PAGE";
      h.parse.mockResolvedValue(changed);
      await expect(
        verifyDocumentInput(approved, uri, { reparse: true }),
      ).rejects.toMatchObject({ code: "changed" });
      expect(approved).toEqual(before);
    },
  );
  it("source version/hash changes block approval and live dispatch while preserving reviewed text", async () => {
    const review = await read(),
      before = structuredClone(review);
    writeFileSync(
      path,
      Buffer.concat([readFileSync(path), Buffer.from("\nchanged")]),
    );
    await expect(
      confirmDocumentInput(review, { partialSelected: true }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(review).toEqual(before);
    writeFileSync(path, readFileSync(fixture));
    const approved = await approve();
    writeFileSync(
      path,
      Buffer.concat([readFileSync(path), Buffer.from("\nchanged")]),
    );
    await expect(verifyDocumentInput(approved, uri)).rejects.toMatchObject({
      code: "changed",
    });
    expect(approved.text).toBe(review.text);
  });
  it("unknown source, URI mismatch and edited text reject before any source I/O", async () => {
    const approved = await approve();
    h.invoke.mockClear();
    await expect(
      verifyDocumentInput({ text: approved.text, local: null }, uri, {
        reparse: true,
      }),
    ).rejects.toMatchObject({ code: "sourceUnknown" });
    await expect(
      verifyDocumentInput(approved, "file:///other.pdf"),
    ).rejects.toMatchObject({ code: "changed" });
    await expect(
      verifyDocumentInput(
        {
          ...approved,
          text: approved.text.replace("WHOLE_PAGE_3", "WRONG_PAGE_3"),
        },
        uri,
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(h.invoke).not.toHaveBeenCalled();
  });
  it("PDF can capture above 16MiB; original DOCX/XLSX limits remain unchanged", async () => {
    const bytes = Buffer.concat([
      readFileSync(fixture),
      Buffer.alloc(16 * 1024 * 1024, 32),
    ]);
    writeFileSync(path, bytes);
    expect((await read()).local.source.size).toBe(bytes.length);
    for (const suffix of ["docx", "xlsx"]) {
      h.invoke.mockClear();
      h.invoke.mockResolvedValue({
        ...receipt(),
        path: path.replace(/pdf$/, suffix),
      });
      await expect(
        readDocumentInput(
          { uri: uri.replace(/pdf$/, suffix), name: `chosen.${suffix}` },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "limit" });
      expect(h.invoke).toHaveBeenCalledOnce();
    }
  });
  it.each([
    "incomplete",
    "encrypted",
    "textLimit",
    "readBusy",
    "readPending",
  ] as const)("retains typed %s failure, no prefix review", async (code) => {
    h.parse.mockRejectedValue(new PdfInputError(code));
    await expect(read()).rejects.toMatchObject({ code });
    expect(
      h.invoke.mock.calls.some(
        ([command]) =>
          command === "file_delivery_check_revision" ||
          command === "session_prompt",
      ),
    ).toBe(false);
  });
  it("zero author text is not made usable by generated page/scope labels", async () => {
    const empty = result();
    empty.pages.forEach((p) => (p.items = []));
    empty.warnings.push({ code: "pagesWithoutText", count: 3, unit: "pages" });
    h.parse.mockResolvedValue(empty);
    await expect(read()).rejects.toMatchObject({ code: "noText" });
  });
  it.each(["lateInvalid", "wholeUtf8Limit"])(
    "rejects %s of a returned whole result instead of approving a page prefix",
    async (boundary) => {
      const invalid = result();
      if (boundary === "lateInvalid") invalid.pages[2].number = 4;
      else invalid.pages[2].items[0].text = "界".repeat(90_000);
      h.parse.mockResolvedValue(invalid);
      await expect(read()).rejects.toMatchObject({
        code: boundary === "lateInvalid" ? "invalid" : "textLimit",
      });
      expect(
        h.invoke.mock.calls.some(
          ([command]) => command === "file_delivery_check_revision",
        ),
      ).toBe(false);
    },
  );
  it("a cancelled late parser result cannot become approved review", async () => {
    let finish: (value: PdfInputResult) => void = () => {};
    h.parse.mockImplementation(
      () => new Promise<PdfInputResult>((resolve) => (finish = resolve)),
    );
    const control = new AbortController(),
      pending = read({ pdf: request }, control.signal);
    await vi.waitFor(() => expect(h.parse).toHaveBeenCalledOnce());
    const rejected = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    control.abort();
    finish(result());
    await rejected;
    expect(
      h.invoke.mock.calls.some(
        ([command]) => command === "file_delivery_check_revision",
      ),
    ).toBe(false);
  });
});
