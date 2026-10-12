import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docxFixtureBytes } from "./docx_fixture";
import { parseDocx } from "./docx_parse";
import { DocxError, type DocxWorkerInput } from "./docx_types";
import {
  confirmDocumentInput,
  readDocumentInput,
  verifyDocumentInput,
} from "./document_input";
import type { VerifiedFile } from "./file_delivery";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const fixtures = new URL(
  "../../docs/evidence/2026-10-09-capability-hardening/docx-input/fixtures/",
  import.meta.url,
);
let directory: string, path: string, uri: string;
function receipt(): VerifiedFile {
  const bytes = readFileSync(path),
    hash = createHash("sha256").update(bytes).digest("hex");
  return {
    root: directory,
    path,
    resolvedPath: path,
    name: "chosen.docx",
    size: bytes.byteLength,
    sha256: hash,
    version: `fixture:${hash}`,
  };
}
function select(name: string) {
  writeFileSync(path, readFileSync(new URL(`${name}.docx`, fixtures)));
}
/** Unit IPC substitute reads actual fresh ZIP bytes; native path/CRC/OS safety
 * remains covered separately by the real Rust capture tests. */
function nativeCalls(
  command: string,
  args: { file?: VerifiedFile; path?: string; mode?: string },
) {
  if (command === "file_delivery_inspect_selected") {
    expect(args.path).toBe(path);
    return Promise.resolve(receipt());
  }
  if (command === "file_delivery_read_docx") {
    expect(args.file).toEqual(receipt());
    const input = docxFixtureBytes(readFileSync(path));
    return Promise.resolve({
      file: receipt(),
      ...input,
      inflatedBytes: input.parts.reduce(
        (sum, part) => sum + Buffer.from(part.data, "base64").length,
        0,
      ),
    });
  }
  if (command === "file_delivery_check_revision") {
    expect(args.mode).toBe("content");
    return Promise.resolve({ kind: "verified", file: receipt() });
  }
  throw new Error(`unexpected unit IPC ${command}`);
}
class ParsingWorker extends EventTarget {
  static instances: ParsingWorker[] = [];
  static delayed = false;
  input?: DocxWorkerInput;
  terminate = vi.fn();
  constructor() {
    super();
    ParsingWorker.instances.push(this);
  }
  postMessage(input: DocxWorkerInput) {
    this.input = input;
    if (!ParsingWorker.delayed) queueMicrotask(() => this.finish());
  }
  finish() {
    try {
      const document = parseDocx(this.input!);
      this.dispatchEvent(
        new MessageEvent("message", { data: { kind: "ready", document } }),
      );
    } catch (error) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            kind: "error",
            code: error instanceof DocxError ? error.code : "invalid",
          },
        }),
      );
    }
  }
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "farfold-docx-input-unit-"));
  path = join(directory, "chosen.docx");
  uri = new URL(`file://${path}`).href;
  select("complete");
  invoke.mockImplementation(nativeCalls);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Worker", ParsingWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  invoke.mockReset();
  ParsingWorker.instances = [];
  ParsingWorker.delayed = false;
  rmSync(directory, { recursive: true, force: true });
});
const read = (signal = new AbortController().signal) =>
  readDocumentInput({ uri, name: "chosen.docx" }, signal);
const approve = async () =>
  confirmDocumentInput(await read(), { partialSelected: false });

describe("DOCX selected read, approval and source verification", () => {
  it("delivers full real ZIP content only after distinct confirmation, then live checks without reparsing", async () => {
    const review = await read();
    expect(review.text).toContain("LONG_END_721a");
    expect(review.text).toContain("LAST_CELL_8f94");
    expect(review.local.source).toEqual(receipt());
    expect(review.local.textSha256).toBe(
      createHash("sha256").update(review.text).digest("hex"),
    );
    expect(review.local.utf8Bytes).toBe(Buffer.byteLength(review.text));
    const approved = await confirmDocumentInput(review, {
      partialSelected: false,
    });
    const saved = structuredClone(approved),
      parses = ParsingWorker.instances.length;
    await verifyDocumentInput(approved, uri);
    expect(ParsingWorker.instances).toHaveLength(parses);
    expect(approved).toEqual(saved);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "file_delivery_inspect_selected",
      "file_delivery_read_docx",
      "file_delivery_check_revision",
      "file_delivery_check_revision",
    ]);
    expect(ParsingWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it("cold review fully reparses without mutating or granting send authority", async () => {
    const approved = await approve(),
      before = structuredClone(approved);
    await verifyDocumentInput(approved, uri, { reparse: true });
    expect(ParsingWorker.instances).toHaveLength(2);
    expect(approved).toEqual(before);
    expect(invoke.mock.calls.some(([name]) => name === "session_prompt")).toBe(
      false,
    );
  });
  it("requires explicit selection for partial content and never includes hidden text", async () => {
    select("partial-hidden");
    const review = await read();
    expect(review.local.partial).toBe(true);
    await expect(
      confirmDocumentInput(review, { partialSelected: false }),
    ).rejects.toMatchObject({ code: "invalid" });
    const approved = await confirmDocumentInput(review, {
      partialSelected: true,
    });
    expect(approved.local?.partialSelected).toBe(true);
    expect(approved.text).not.toContain("HIDDEN_d4a5_MUST_NOT_APPEAR");
    await verifyDocumentInput(approved, uri, { reparse: true });
  });
  it("rejects only-image plus empty note markers but keeps real author literal [1]", async () => {
    select("image-empty-note");
    await expect(read()).rejects.toMatchObject({ code: "noText" });
    select("literal-marker");
    const review = await read();
    expect(review.actualTextChars).toBe(3);
    expect(review.text).toContain("[1]");
  });
  it("rejects an active object from real ZIP parts with a safe short failure", async () => {
    select("active-object");
    await expect(read()).rejects.toMatchObject({ code: "unsupported" });
  });
  it("rejects changed source before confirmation or live send and leaves reviewed text intact", async () => {
    const review = await read(),
      saved = review.text;
    const changed = readFileSync(path);
    changed[changed.length - 1] ^= 1;
    writeFileSync(path, changed);
    await expect(
      confirmDocumentInput(review, { partialSelected: false }),
    ).rejects.toMatchObject({ code: "changed" });
    expect(review.text).toBe(saved);
    select("complete");
    const approved = await approve(),
      before = structuredClone(approved);
    const changedAgain = readFileSync(path);
    changedAgain[changedAgain.length - 2] ^= 1;
    writeFileSync(path, changedAgain);
    await expect(verifyDocumentInput(approved, uri)).rejects.toMatchObject({
      code: "changed",
    });
    expect(approved).toEqual(before);
  });
  it("does not accept metadata hints, wrong URI, query authority, or null history source", async () => {
    const approved = await approve();
    invoke.mockClear();
    await expect(
      verifyDocumentInput(approved, `${uri}?override=1`),
    ).rejects.toMatchObject({ code: "sourceUnknown" });
    await expect(
      verifyDocumentInput(approved, "file:///another.docx"),
    ).rejects.toMatchObject({ code: "changed" });
    await expect(
      verifyDocumentInput({ text: approved.text, local: null }, uri),
    ).rejects.toMatchObject({ code: "sourceUnknown" });
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValue({ kind: "hintUnchanged" });
    await expect(verifyDocumentInput(approved, uri)).rejects.toMatchObject({
      code: "changed",
    });
  });
  it("rejects body edits with unchanged metadata digest, even when source file is unchanged", async () => {
    const approved = await approve();
    const altered = {
      ...approved,
      text: approved.text.replace("BODY_END_99e1", "BODY_END_99e2"),
    };
    invoke.mockClear();
    await expect(verifyDocumentInput(altered, uri)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("pre-abort reads no file and pending inspection cancellation cannot publish late results", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(read(aborted.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(invoke).not.toHaveBeenCalled();
    let finish: (v: VerifiedFile) => void = () => {};
    invoke.mockImplementation(
      () =>
        new Promise<VerifiedFile>((resolve) => {
          finish = resolve;
        }),
    );
    const control = new AbortController(),
      pending = read(control.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "cancelled",
    });
    control.abort();
    await rejected;
    finish(receipt());
    await Promise.resolve();
    expect(ParsingWorker.instances).toHaveLength(0);
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("cancelled Worker completion stays discarded and another parse is allowed afterwards", async () => {
    ParsingWorker.delayed = true;
    const control = new AbortController(),
      pending = read(control.signal);
    await vi.waitFor(() => expect(ParsingWorker.instances).toHaveLength(1));
    const old = ParsingWorker.instances[0],
      rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    control.abort();
    await rejected;
    old.finish();
    expect(old.terminate).toHaveBeenCalledOnce();
    ParsingWorker.delayed = false;
    expect((await read()).text).toContain("BODY_END_99e1");
  });
  it.each(["busy", "pending"])(
    "retains %s read failures and hides provider/private error text",
    async (code) => {
      const approved = await approve();
      invoke.mockRejectedValue({ code, message: "PRIVATE_ERROR_NOT_VISIBLE" });
      await expect(verifyDocumentInput(approved, uri)).rejects.toMatchObject({
        code: code === "busy" ? "readBusy" : "readPending",
      });
      try {
        await verifyDocumentInput(approved, uri);
      } catch (error) {
        expect((error as Error).message).not.toContain(
          "PRIVATE_ERROR_NOT_VISIBLE",
        );
      }
    },
  );
});
