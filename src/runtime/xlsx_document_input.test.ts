import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inputFixtureDirectory,
  inputZipFixture,
} from "./xlsx_input_fixture.test-support";
import { parseWorkbookInput } from "./xlsx_input_parse";
import { XlsxInputError, type XlsxInputWorkerInput } from "./xlsx_input_types";
import { XlsxError } from "./xlsx_types";
import {
  confirmDocumentInput,
  readDocumentInput,
  verifyDocumentInput,
} from "./document_input";
import type { VerifiedFile } from "./file_delivery";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let directory: string, path: string, uri: string, selected: string;
function receipt(): VerifiedFile {
  const bytes = readFileSync(path),
    hash = createHash("sha256").update(bytes).digest("hex");
  return {
    root: directory,
    path,
    resolvedPath: path,
    name: "chosen.xlsx",
    size: bytes.length,
    sha256: hash,
    version: `fixture:${hash}`,
  };
}
function select(id: string) {
  selected = id;
  writeFileSync(
    path,
    readFileSync(new URL(id + ".xlsx", inputFixtureDirectory)),
  );
}
function native(
  command: string,
  args: { file?: VerifiedFile; path?: string; mode?: string },
) {
  if (command === "file_delivery_inspect_selected") {
    expect(args.path).toBe(path);
    return Promise.resolve(receipt());
  }
  if (command === "file_delivery_read_workbook") {
    expect(args.file).toEqual(receipt());
    // Fresh selected actual ZIP bytes must equal the independently pinned ZIP;
    // this stand-in does not claim native path/CRC/OS capture validation.
    expect(readFileSync(path)).toEqual(
      readFileSync(new URL(selected + ".xlsx", inputFixtureDirectory)),
    );
    return Promise.resolve({ ...inputZipFixture(selected), file: receipt() });
  }
  if (command === "file_delivery_check_revision") {
    expect(args.mode).toBe("content");
    return Promise.resolve({ kind: "verified", file: receipt() });
  }
  throw new Error("unexpected IPC " + command);
}
class InputWorker extends EventTarget {
  static instances: InputWorker[] = [];
  static delayed = false;
  static alteredScope = false;
  static scopeEmpty = false;
  input?: XlsxInputWorkerInput;
  terminate = vi.fn();
  constructor() {
    super();
    InputWorker.instances.push(this);
  }
  postMessage(input: XlsxInputWorkerInput) {
    expect(input.kind).toBe("input");
    this.input = input;
    if (!InputWorker.delayed) queueMicrotask(() => this.finish());
  }
  finish() {
    try {
      if (InputWorker.scopeEmpty) throw new XlsxInputError("scopeEmpty");
      const workbook = parseWorkbookInput(this.input!, this.input!.request);
      if (InputWorker.alteredScope) workbook.scope.sheetIds.reverse();
      this.dispatchEvent(
        new MessageEvent("message", { data: { kind: "inputReady", workbook } }),
      );
    } catch (error) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            kind: "error",
            code:
              error instanceof XlsxError || error instanceof XlsxInputError
                ? error.code
                : "invalid",
          },
        }),
      );
    }
  }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "farfold-xlsx-input-unit-"));
  path = join(directory, "chosen.xlsx");
  uri = new URL(`file://${path}`).href;
  select("01-values-scope");
  invoke.mockImplementation(native);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Worker", InputWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockReset();
  InputWorker.instances = [];
  InputWorker.delayed = false;
  InputWorker.alteredScope = false;
  InputWorker.scopeEmpty = false;
  rmSync(directory, { recursive: true, force: true });
});
const read = (
  mode?: "all-saved-cells" | "visible-saved-cells",
  signal = new AbortController().signal,
) =>
  readDocumentInput(
    { uri, name: "chosen.xlsx" },
    signal,
    mode ? { xlsx: { mode } } : undefined,
  );
const approvedAll = async () =>
  confirmDocumentInput(await read("all-saved-cells"), {
    partialSelected: true,
  });

describe("XLSX common input with actual ZIP and full parse", () => {
  it("defaults to all visible sheets, retains every visible authored cell including distant tails, and requires partial consent", async () => {
    const review = await read();
    expect(review.local).toMatchObject({
      format: "xlsx",
      selection: "read-saved-cell-content",
      scope: { mode: "visible-saved-cells", sheetIds: ["rId1", "rId2"] },
    });
    expect(review.local).not.toHaveProperty("imageReferences");
    expect(review.text).toContain("FAR_CORNER");
    expect(review.text).toContain("END_TAIL");
    expect(review.text).toContain("9007199254740993");
    for (const absent of [
      "HIDDEN_COLUMN",
      "HIDDEN_ROW",
      "HIDDEN_SHEET",
      "VERY_HIDDEN_SHEET",
      '"address":"C4"',
    ])
      expect(review.text).not.toContain(absent);
    expect(review.local.warnings).toContainEqual({
      code: "hiddenCellsOmitted",
      count: 5,
    });
    await expect(
      confirmDocumentInput(review, { partialSelected: false }),
    ).rejects.toMatchObject({ code: "invalid" });
    const approved = await confirmDocumentInput(review, {
      partialSelected: true,
    });
    expect(approved.local?.textSha256).toBe(
      createHash("sha256").update(review.text).digest("hex"),
    );
    expect(approved.local?.utf8Bytes).toBe(Buffer.byteLength(review.text));
    expect(InputWorker.instances).toHaveLength(1);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "file_delivery_inspect_selected",
      "file_delivery_read_workbook",
      "file_delivery_check_revision",
    ]);
  });
  it("recovered all-saved reparses original complete scope once, preserving hidden text and exact metadata without sending", async () => {
    const approved = await approvedAll(),
      before = structuredClone(approved);
    expect(approved.text).toContain("HIDDEN_COLUMN");
    expect(approved.text).toContain("VERY_HIDDEN_SHEET");
    invoke.mockClear();
    await verifyDocumentInput(approved, uri, { reparse: true });
    expect(approved).toEqual(before);
    expect(InputWorker.instances).toHaveLength(2);
    expect(InputWorker.instances[1].input?.request).toEqual({
      mode: "all-saved-cells",
    });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "file_delivery_check_revision",
      "file_delivery_inspect_selected",
      "file_delivery_read_workbook",
    ]);
    expect(invoke.mock.calls.some(([name]) => name === "session_prompt")).toBe(
      false,
    );
  });
  it("does not accept retained changed sheet IDs/warnings/partial as cold authority, even for unchanged file and text", async () => {
    const approved = await approvedAll();
    if (approved.local?.format !== "xlsx") throw new Error("fixture format");
    for (const local of [
      {
        ...approved.local,
        scope: {
          ...approved.local.scope,
          sheetIds: [...approved.local.scope.sheetIds].reverse(),
        },
      },
      { ...approved.local, warnings: [], partial: false },
    ]) {
      await expect(
        verifyDocumentInput({ text: approved.text, local }, uri, {
          reparse: true,
        }),
      ).rejects.toMatchObject({ code: "changed" });
    }
    expect(approved.local.scope.sheetIds).toEqual([
      "rId1",
      "rId2",
      "rId3",
      "rId4",
    ]);
  });
  it("rejects altered Worker catalog order rather than accepting a prefix or preview result", async () => {
    InputWorker.alteredScope = true;
    await expect(read()).rejects.toMatchObject({ code: "invalid" });
  });
  it("keeps typed empty scope failure and does not fallback to a hidden sheet or another request", async () => {
    InputWorker.scopeEmpty = true;
    await expect(read()).rejects.toMatchObject({ code: "scopeEmpty" });
    expect(InputWorker.instances).toHaveLength(1);
    expect(InputWorker.instances[0].input?.request).toEqual({
      mode: "visible-saved-cells",
    });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "file_delivery_inspect_selected",
      "file_delivery_read_workbook",
    ]);
    expect(InputWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it("pre-aborted XLSX input reads no source and cancelled inspection cannot create a late Worker", async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(read(undefined, pre.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(invoke).not.toHaveBeenCalled();
    let finish!: (file: VerifiedFile) => void;
    invoke.mockReturnValue(
      new Promise<VerifiedFile>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController(),
      pending = read(undefined, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    controller.abort();
    await rejected;
    finish(receipt());
    await Promise.resolve();
    expect(InputWorker.instances).toHaveLength(0);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("rejects invalid late worksheet and final UTF8 overflow atomically without prefix approval", async () => {
    select("04-invalid-late-sheet");
    await expect(read()).rejects.toMatchObject({ code: "invalid" });
    select("05-text-budget");
    await expect(read()).rejects.toMatchObject({ code: "textLimit" });
  });
  it("source change after review rejects confirmation and a live send check while retaining original text", async () => {
    const review = await read("all-saved-cells"),
      old = structuredClone(review);
    select("02-protection-format");
    await expect(
      confirmDocumentInput(review, { partialSelected: true }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(review).toEqual(old);
    select("01-values-scope");
    const approved = await approvedAll();
    select("03-unread-surfaces");
    await expect(verifyDocumentInput(approved, uri)).rejects.toMatchObject({
      code: "changed",
    });
    expect(approved.text).toBe(old.text);
  });
  it("rejects unknown source, wrong URI and edited body before any file read; hints never suffice", async () => {
    const approved = await approvedAll();
    invoke.mockClear();
    for (const [value, source, code] of [
      [{ text: approved.text, local: null }, uri, "sourceUnknown"],
      [approved, "file:///other.xlsx", "changed"],
      [
        { ...approved, text: approved.text.replace("END_TAIL", "END_FAIL") },
        uri,
        "invalid",
      ],
    ] as const)
      await expect(verifyDocumentInput(value, source)).rejects.toMatchObject({
        code,
      });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ kind: "hintUnchanged" });
    await expect(verifyDocumentInput(approved, uri)).rejects.toMatchObject({
      code: "changed",
    });
  });
  it("cancelled Worker cannot publish late success and releases its slot for a new full read", async () => {
    InputWorker.delayed = true;
    const control = new AbortController(),
      pending = read(undefined, control.signal);
    await vi.waitFor(() => expect(InputWorker.instances).toHaveLength(1));
    const old = InputWorker.instances[0],
      rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    control.abort();
    await rejected;
    old.finish();
    expect(old.terminate).toHaveBeenCalledOnce();
    InputWorker.delayed = false;
    expect((await read()).text).toContain("END_TAIL");
  });
  it.each(["busy", "pending"])(
    "retains typed %s failures without private error text",
    async (code) => {
      invoke.mockRejectedValue({ code, message: "PRIVATE_NEVER_SHOW" });
      await expect(read()).rejects.toMatchObject({
        code: code === "busy" ? "readBusy" : "readPending",
      });
      try {
        await read();
      } catch (error) {
        expect((error as Error).message).not.toContain("PRIVATE_NEVER_SHOW");
      }
    },
  );
});
