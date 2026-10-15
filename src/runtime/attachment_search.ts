import { isAbsoluteFilePath } from "./file_paths";
import { invoke } from "@tauri-apps/api/core";
import { fileDelivery, type VerifiedFile } from "./file_delivery";
import { sameFileRevision } from "./file_revision_monitor";
import { FILE_DELIVERY_STRINGS as D } from "./file_delivery_strings";
import { readDocxPreview } from "./docx_preview";
import { readWorkbookInput } from "./xlsx_preview";
import { readPdfInput } from "./pdf_input_read";
import { readPptxPreview } from "./pptx_preview";
import { PptxError, type PptxCapture, type PptxPreview } from "./pptx_types";
import {
  pptxSearchText,
  snapshotPptxSearchCapture,
  type PptxSearchLocation,
  type PptxSearchScope,
} from "./attachment_search_pptx";
import { decodePdfInputCapture } from "./pdf_input_capture";
import {
  PdfInputError,
  type PdfInputCapture,
  type PdfInputResult,
} from "./pdf_input_types";
import {
  pdfSearchText,
  type PdfSearchLocation,
  type PdfSearchScope,
} from "./pdf_search_text";
import { XLSX_LIMITS, XlsxError, type WorkbookCapture } from "./xlsx_types";
import type { XlsxInputResult } from "./xlsx_input_types";
import {
  xlsxSearchText,
  type XlsxSearchLocation,
  type XlsxSearchScope,
} from "./xlsx_search_text";
import {
  DOCX_LIMITS,
  DocxError,
  type DocxCapture,
  type DocxPreview,
} from "./docx_types";
import {
  docxSearchText,
  type DocxSearchLocation,
  type DocxSearchScope,
} from "./docx_search_text";
import {
  knownAttachmentSearchCandidate,
  attachmentSearchIsDocx,
  attachmentSearchIsXlsx,
  attachmentSearchIsPdf,
  attachmentSearchIsPptx,
  type AttachmentSearchCandidate,
} from "./attachment_search_source";

export const ATTACHMENT_SEARCH_LIMITS = {
  files: 20,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  concurrent: 2,
  hits: 200,
  queryBytes: 256,
} as const;
export type AttachmentSearchCode =
  | "changed"
  | "unreadable"
  | "tooLarge"
  | "unsupported"
  | "budget"
  | "pending"
  | "busy"
  | "documentLimit"
  | "encrypted"
  | "timeout"
  | "scopeEmpty"
  | "pdfNoText"
  | "pdfIncomplete"
  | "invalid";
export type AttachmentSearchRow = {
  source: AttachmentSearchCandidate;
  state: "queued" | "checking" | "reading" | "searched" | "error" | "skipped";
  code?: AttachmentSearchCode;
  matches: number;
  file?: VerifiedFile;
  document?: DocxSearchScope;
  workbook?: XlsxSearchScope;
  pdf?: PdfSearchScope;
  presentation?: PptxSearchScope;
};
export type AttachmentSearchHit = Readonly<{
  source: AttachmentSearchCandidate;
  file: VerifiedFile;
  before: string;
  match: string;
  after: string;
  location?:
    | DocxSearchLocation
    | XlsxSearchLocation
    | PdfSearchLocation
    | PptxSearchLocation;
}>;
export type AttachmentSearchState = {
  phase:
    | "idle"
    | "reading"
    | "cancelling"
    | "cancelled"
    | "stale"
    | "complete"
    | "pending";
  rows: readonly AttachmentSearchRow[];
  hits: readonly AttachmentSearchHit[];
  matches: number;
  bytes: number;
  error?: AttachmentSearchCode;
  previousPending?: boolean;
};
export interface AttachmentSearchPort {
  inspect(path: string): Promise<unknown>;
  read(file: VerifiedFile): Promise<unknown>;
  check(file: VerifiedFile): Promise<unknown>;
  readDocx?(file: VerifiedFile): Promise<unknown>;
  parseDocx?(capture: DocxCapture, signal: AbortSignal): Promise<DocxPreview>;
  readWorkbook?(file: VerifiedFile): Promise<unknown>;
  parseWorkbook?(
    capture: WorkbookCapture,
    signal: AbortSignal,
  ): Promise<XlsxInputResult>;
  readPdf?(file: VerifiedFile): Promise<unknown>;
  parsePdf?(
    capture: PdfInputCapture,
    signal: AbortSignal,
  ): Promise<PdfInputResult>;
  readPptx?(file: VerifiedFile): Promise<unknown>;
  parsePptx?(capture: PptxCapture, signal: AbortSignal): Promise<PptxPreview>;
}
const port: AttachmentSearchPort = {
  inspect: (path) => invoke("file_delivery_inspect_text", { path }),
  read: (file) => fileDelivery.readText(file),
  check: (file) => invoke("file_delivery_check_text_revision", { file }),
  readDocx: (file) => invoke("file_delivery_read_docx_search", { file }),
  parseDocx: readDocxPreview,
  readWorkbook: (file) =>
    invoke("file_delivery_read_workbook_search", { file }),
  parseWorkbook: (capture, signal) =>
    readWorkbookInput(capture, { mode: "visible-saved-cells" }, signal),
  readPdf: (file) => invoke("file_delivery_read_pdf_search", { file }),
  parsePdf: (capture, signal) =>
    readPdfInput(
      capture,
      {
        mode: "decoded-page-text",
        includePossiblyInvisibleText: true,
      },
      signal,
    ),
  // Await the real read receipt. Cancelling the parser does not settle an OS read.
  readPptx: (file) => invoke("file_delivery_read_pptx_search", { file }),
  parsePptx: readPptxPreview,
};
const initial = (): AttachmentSearchState => ({
  phase: "idle",
  rows: [],
  hits: [],
  matches: 0,
  bytes: 0,
  error: undefined,
  previousPending: false,
});
function fail(code: AttachmentSearchCode): never {
  throw { code };
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("invalid");
  return v as Record<string, unknown>;
}
function file(v: unknown, path: string): VerifiedFile {
  const f = record(v);
  const fields = [
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ];
  if (
    Object.keys(f).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(f, k)) ||
    fields
      .filter((k) => k !== "size")
      .some(
        (k) =>
          typeof f[k] !== "string" ||
          !f[k] ||
          /[\u0000-\u001f\u007f]/.test(f[k] as string),
      ) ||
    !Number.isSafeInteger(f.size) ||
    Number(f.size) < 0 ||
    f.path !== path ||
    ![f.root, f.path, f.resolvedPath].every(
      (v) => typeof v === "string" && isAbsoluteFilePath(v),
    ) ||
    !/^[a-f0-9]{64}$/.test(f.sha256 as string)
  )
    fail("invalid");
  return Object.freeze({ ...f }) as unknown as VerifiedFile;
}
function failure(e: unknown): AttachmentSearchCode {
  const code = e && typeof e === "object" && "code" in e ? e.code : null;
  if (
    [
      "changed",
      "unreadable",
      "tooLarge",
      "unsupported",
      "budget",
      "pending",
      "busy",
      "documentLimit",
      "encrypted",
      "timeout",
      "scopeEmpty",
      "pdfNoText",
      "pdfIncomplete",
      "invalid",
    ].includes(String(code))
  )
    return code as AttachmentSearchCode;
  if (code === "limit" || code === "textLimit") return "documentLimit";
  if (code === "incomplete") return "pdfIncomplete";
  if (code === "scopeRequired") return "invalid";
  if (code === "readPending") return "pending";
  if (code === "readBusy") return "busy";
  if (["missing", "redirected", "changing", "notFile"].includes(String(code)))
    return "changed";
  const message = e instanceof Error ? e.message : e;
  // Existing readText deliberately exposes these fixed public messages.
  if (message === "此文件无法作为文字预览，请另存或使用其他应用打开")
    return "unsupported";
  if (
    message === "文件或位置已变化，请重新检查" ||
    message === "此位置不是普通文件"
  )
    return "changed";
  if (message === "文件超过当前操作的大小限制") return "tooLarge";
  if (message === D.checkBusy) return "busy";
  if (message === D.checkWaitExpired) return "pending";
  return "unreadable";
}
export function validAttachmentSearchQuery(query: string): boolean {
  return (
    !!query.trim() &&
    new TextEncoder().encode(query.trim()).length <=
      ATTACHMENT_SEARCH_LIMITS.queryBytes &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(
      query.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
    )
  );
}
async function textPayload(
  value: unknown,
  expected: VerifiedFile,
): Promise<string> {
  const v = record(value),
    f = file(v.file, expected.path);
  if (!sameFileRevision(expected, f) || typeof v.text !== "string")
    fail("changed");
  const text = v.text;
  if (text.length > ATTACHMENT_SEARCH_LIMITS.fileBytes) fail("tooLarge");
  if (
    text.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))
  )
    fail("unsupported");
  const bytes = new TextEncoder().encode(text);
  if (
    bytes.length !== expected.size ||
    bytes.length > ATTACHMENT_SEARCH_LIMITS.fileBytes
  )
    fail("changed");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== expected.sha256) fail("changed");
  return text;
}
/** Only explicit start admits reads. Cancel retires results, not real OS work. */
export class AttachmentSearch {
  private state = initial();
  private listeners = new Set<() => void>();
  private flight: {
    current: () => boolean;
    cancelled: boolean;
    retired: boolean;
    abort: AbortController;
  } | null = null;
  private pending = false;
  private locating = false;
  constructor(private services: AttachmentSearchPort = port) {}
  snapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit(change: Partial<AttachmentSearchState>) {
    this.state = { ...this.state, ...change };
    for (const f of this.listeners) f();
  }
  private row(index: number, change: Partial<AttachmentSearchRow>) {
    this.emit({
      rows: this.state.rows.map((r, i) =>
        i === index ? { ...r, ...change } : r,
      ),
    });
  }
  busy = () => !!this.flight || this.pending || this.locating;
  active = () => !!this.flight || this.locating;
  cancel() {
    if (this.flight) {
      this.flight.cancelled = true;
      this.flight.abort.abort();
      this.emit({ phase: "cancelling", hits: [], matches: 0 });
    }
  }
  retire() {
    if (this.flight) {
      this.flight.retired = true;
      this.flight.abort.abort();
    }
    this.emit({
      ...initial(),
      phase: this.flight ? "cancelling" : this.pending ? "pending" : "idle",
    });
  }
  async start(
    query: string,
    sources: readonly AttachmentSearchCandidate[],
    current: () => boolean,
  ) {
    if (this.active() || !current()) return false;
    if (
      !validAttachmentSearchQuery(query) ||
      !sources.length ||
      sources.length > ATTACHMENT_SEARCH_LIMITS.files ||
      new Set(sources.map((s) => s.id)).size !== sources.length ||
      sources.some((s) => !s.path || !knownAttachmentSearchCandidate(s))
    ) {
      this.emit({ ...initial(), error: "invalid" });
      return false;
    }
    const run = {
      current,
      cancelled: false,
      retired: false,
      abort: new AbortController(),
    };
    // Only this explicit start can retry an unknown read. The native pool's
    // real worker still owns its permit; no UI action releases that work.
    const previousPending = this.pending;
    this.pending = false;
    this.flight = run;
    const valid = () => !run.cancelled && !run.retired && run.current();
    this.emit({
      phase: "reading",
      rows: sources.map((source) => ({ source, state: "queued", matches: 0 })),
      hits: [],
      matches: 0,
      bytes: 0,
      error: undefined,
      previousPending,
    });
    const checked = new Map<number, VerifiedFile>();
    const pool = async (action: (index: number) => Promise<void>) => {
      let next = 0;
      await Promise.all(
        Array.from({ length: 2 }, async () => {
          while (next < sources.length && valid() && !this.pending)
            await action(next++);
        }),
      );
    };
    const error = (index: number, e: unknown) => {
      const code = failure(e);
      if (code === "pending") this.pending = true;
      if (valid()) this.row(index, { state: "error", code });
    };
    try {
      await pool(async (i) => {
        this.row(i, { state: "checking" });
        try {
          const f = file(
            await this.services.inspect(sources[i].path!),
            sources[i].path!,
          );
          if (!valid()) return;
          if (f.size > ATTACHMENT_SEARCH_LIMITS.fileBytes) fail("tooLarge");
          checked.set(i, f);
        } catch (e) {
          error(i, e);
        }
      });
      type Content = {
        segments: readonly {
          text: string;
          location?:
            | DocxSearchLocation
            | XlsxSearchLocation
            | PdfSearchLocation
            | PptxSearchLocation;
        }[];
        bytes: number;
        document?: DocxSearchScope;
        workbook?: XlsxSearchScope;
        pdf?: PdfSearchScope;
        presentation?: PptxSearchScope;
      };
      // The preview worker is shared with document viewing. Serialize this
      // batch only; an unrelated preview can still honestly report busy.
      let parseTail: Promise<unknown> = Promise.resolve();
      const load = async (
        i: number,
        f: VerifiedFile,
      ): Promise<Content | null> => {
        this.row(i, { state: "reading", file: f });
        try {
          let content: Content;
          if (attachmentSearchIsDocx(sources[i])) {
            if (!this.services.readDocx || !this.services.parseDocx)
              fail("unsupported");
            const capture = record(await this.services.readDocx(f));
            if (!valid() || this.pending) return null;
            if (!sameFileRevision(f, file(capture.file, f.path)))
              fail("changed");
            if (
              !Number.isSafeInteger(capture.inflatedBytes) ||
              Number(capture.inflatedBytes) < 1 ||
              Number(capture.inflatedBytes) > DOCX_LIMITS.bytes ||
              !Array.isArray(capture.parts) ||
              !Array.isArray(capture.entries) ||
              capture.parts.length > DOCX_LIMITS.entries ||
              capture.entries.length > DOCX_LIMITS.entries
            )
              fail("documentLimit");
            const parsed = parseTail.then(async () => {
              if (!valid() || this.pending) throw new DocxError("cancelled");
              return this.services.parseDocx!(
                capture as unknown as DocxCapture,
                run.abort.signal,
              );
            });
            parseTail = parsed.catch(() => undefined);
            const preview = await parsed;
            if (!valid() || this.pending) return null;
            if (!sameFileRevision(f, file(preview.file, f.path)))
              fail("changed");
            content = docxSearchText(preview);
          } else if (attachmentSearchIsXlsx(sources[i])) {
            if (!this.services.readWorkbook || !this.services.parseWorkbook)
              fail("unsupported");
            const capture = record(await this.services.readWorkbook(f));
            if (!valid() || this.pending) return null;
            if (!sameFileRevision(f, file(capture.file, f.path)))
              fail("changed");
            if (
              !Number.isSafeInteger(capture.inflatedBytes) ||
              Number(capture.inflatedBytes) < 1 ||
              Number(capture.inflatedBytes) > XLSX_LIMITS.bytes ||
              !Array.isArray(capture.parts) ||
              !Array.isArray(capture.entries) ||
              capture.parts.length > XLSX_LIMITS.parts ||
              capture.entries.length > XLSX_LIMITS.parts
            )
              fail("documentLimit");
            const parsed = parseTail.then(async () => {
              if (!valid() || this.pending) throw new XlsxError("cancelled");
              return this.services.parseWorkbook!(
                capture as unknown as WorkbookCapture,
                run.abort.signal,
              );
            });
            parseTail = parsed.catch(() => undefined);
            const workbook = await parsed;
            if (!valid() || this.pending) return null;
            if (!sameFileRevision(f, file(capture.file, f.path)))
              fail("changed");
            content = xlsxSearchText(workbook);
          } else if (attachmentSearchIsPdf(sources[i])) {
            if (!this.services.readPdf || !this.services.parsePdf)
              fail("unsupported");
            const value = record(await this.services.readPdf(f));
            if (!valid() || this.pending) return null;
            if (Object.keys(value).length !== 2) fail("invalid");
            // Snapshot before the asynchronous digest. A returned object cannot
            // swap bytes or source metadata between validation and parsing.
            const capture = Object.freeze({
              file: file(value.file, f.path),
              data: value.data as string,
            });
            await decodePdfInputCapture(f, capture, run.abort.signal);
            if (!valid() || this.pending) return null;
            const parsed = parseTail.then(async () => {
              if (!valid() || this.pending)
                throw new PdfInputError("cancelled");
              return this.services.parsePdf!(capture, run.abort.signal);
            });
            parseTail = parsed.catch(() => undefined);
            const pdf = await parsed;
            if (!valid() || this.pending) return null;
            content = pdfSearchText(pdf);
          } else if (attachmentSearchIsPptx(sources[i])) {
            if (!this.services.readPptx || !this.services.parsePptx)
              fail("unsupported");
            const value = record(await this.services.readPptx(f));
            if (!valid() || this.pending) return null;
            const capturedFile = file(value.file, f.path);
            if (!sameFileRevision(f, capturedFile)) fail("changed");
            const capture = snapshotPptxSearchCapture({
              ...value,
              file: capturedFile,
            } as unknown as PptxCapture);
            const capturedParts = new Set(
              capture.parts.map((part) => part.name),
            );
            const parsed = parseTail.then(async () => {
              if (!valid() || this.pending) throw new PptxError("cancelled");
              return this.services.parsePptx!(capture, run.abort.signal);
            });
            parseTail = parsed.catch(() => undefined);
            const preview = await parsed;
            if (!valid() || this.pending) return null;
            if (!sameFileRevision(f, file(preview.file, f.path)))
              fail("changed");
            const { file: _file, ...document } = preview;
            content = pptxSearchText(document, capturedParts);
          } else {
            const text = await textPayload(await this.services.read(f), f);
            content = { segments: [{ text }], bytes: f.size };
          }
          if (!valid() || this.pending) return null;
          const revision = record(await this.services.check(f));
          if (!valid() || this.pending) return null;
          if (
            revision.kind !== "verified" ||
            !sameFileRevision(f, file(revision.file, f.path))
          )
            fail("changed");
          return content;
        } catch (e) {
          error(i, e);
          return null;
        }
      };
      const matches = new Map<number, AttachmentSearchHit[]>();
      const counts = new Map<number, number>();
      let next = 0,
        budget = 0,
        reserved = 0;
      const tasks = new Map<
        number,
        { result: Promise<Content | null>; reservation: number }
      >();
      const fill = () => {
        while (
          next < sources.length &&
          tasks.size < 2 &&
          valid() &&
          !this.pending
        ) {
          const i = next++,
            f = checked.get(i);
          if (!f) continue;
          // Plain UTF-8 bytes are known before reading. DOCX compressed size
          // cannot stand in for its extracted author text, so admit after parse.
          const reservation =
            attachmentSearchIsDocx(sources[i]) ||
            attachmentSearchIsXlsx(sources[i]) ||
            attachmentSearchIsPdf(sources[i]) ||
            attachmentSearchIsPptx(sources[i])
              ? 0
              : f.size;
          if (
            budget + reserved + reservation >
            ATTACHMENT_SEARCH_LIMITS.totalBytes
          ) {
            if (budget + reservation <= ATTACHMENT_SEARCH_LIMITS.totalBytes) {
              // A prefetched read can still fail. Wait for its actual outcome
              // instead of treating its temporary reservation as spent bytes.
              next--;
              break;
            }
            this.row(i, { state: "skipped", code: "budget" });
            continue;
          }
          reserved += reservation;
          tasks.set(i, { result: load(i, f), reservation });
        }
      };
      fill();
      while (tasks.size) {
        const [i, task] = tasks.entries().next().value!;
        const content = await task.result;
        tasks.delete(i);
        reserved -= task.reservation;
        if (content && valid() && !this.pending) {
          if (budget + content.bytes > ATTACHMENT_SEARCH_LIMITS.totalBytes) {
            this.row(i, {
              state: "skipped",
              code: "budget",
              document: content.document,
              workbook: content.workbook,
              pdf: content.pdf,
              presentation: content.presentation,
            });
          } else {
            budget += content.bytes;
            const f = checked.get(i)!;
            const regex = new RegExp(
              query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "giu",
            );
            let count = 0;
            const hits: AttachmentSearchHit[] = [];
            for (const segment of content.segments) {
              for (const match of segment.text.matchAll(regex)) {
                count++;
                if (count % 4096 === 0) {
                  await new Promise<void>((resolve) => setTimeout(resolve, 0));
                  if (!valid() || this.pending) break;
                }
                if (hits.length < ATTACHMENT_SEARCH_LIMITS.hits)
                  hits.push(
                    Object.freeze({
                      source: sources[i],
                      file: f,
                      before: segment.text.slice(
                        Math.max(0, match.index - 56),
                        match.index,
                      ),
                      match: match[0],
                      after: segment.text.slice(
                        match.index + match[0].length,
                        match.index + match[0].length + 88,
                      ),
                      ...(segment.location
                        ? { location: segment.location }
                        : {}),
                    }),
                  );
              }
              if (!valid() || this.pending) break;
            }
            if (valid() && !this.pending) {
              matches.set(i, hits);
              counts.set(i, count);
              this.row(i, {
                state: "searched",
                matches: count,
                document: content.document,
                workbook: content.workbook,
                pdf: content.pdf,
                presentation: content.presentation,
              });
              this.emit({ bytes: budget });
            }
          }
        }
        fill();
      }
      if (run.retired) return false;
      const phase = this.pending
        ? "pending"
        : run.cancelled
          ? "cancelled"
          : !run.current()
            ? "stale"
            : "complete";
      const hits =
        phase === "complete"
          ? [...matches]
              .sort((a, b) => a[0] - b[0])
              .flatMap(([, h]) => h)
              .slice(0, ATTACHMENT_SEARCH_LIMITS.hits)
          : [];
      this.emit({
        phase,
        hits,
        matches:
          phase === "complete"
            ? [...counts.values()].reduce((a, b) => a + b, 0)
            : 0,
        rows: this.state.rows.map((r) =>
          r.state === "queued" ||
          r.state === "checking" ||
          r.state === "reading"
            ? { ...r, state: "skipped" }
            : r,
        ),
      });
      return phase === "complete";
    } finally {
      this.flight = null;
      if (run.retired)
        this.emit({ ...initial(), phase: this.pending ? "pending" : "idle" });
      else this.emit({});
    }
  }
  /** Explicit navigation rechecks bytes; it cannot reload a conversation. */
  async verifyHit(hit: AttachmentSearchHit, current: () => boolean) {
    if (this.busy() || !current() || !this.state.hits.includes(hit))
      return false;
    this.locating = true;
    this.emit({});
    try {
      const value = record(await this.services.check(hit.file));
      if (!current() || !this.state.hits.includes(hit)) return false;
      if (
        value.kind !== "verified" ||
        !sameFileRevision(hit.file, file(value.file, hit.file.path))
      )
        fail("changed");
      return true;
    } catch (e) {
      const code = failure(e);
      if (code === "pending") {
        this.pending = true;
        this.emit({ phase: "pending", hits: [], matches: 0 });
      } else if (current() && this.state.hits.includes(hit))
        this.emit({ phase: "stale", hits: [], matches: 0, error: code });
      return false;
    } finally {
      this.locating = false;
      this.emit({});
    }
  }
}

/** One shared operation; leaving/reentering a view cannot bypass pending reads. */
export const attachmentSearch = new AttachmentSearch();
