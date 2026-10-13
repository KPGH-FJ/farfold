import { isAbsoluteFilePath } from "./file_paths";
import { invoke } from "@tauri-apps/api/core";
import { fileDelivery, type VerifiedFile } from "./file_delivery";
import { sameFileRevision } from "./file_revision_monitor";
import { FILE_DELIVERY_STRINGS as D } from "./file_delivery_strings";
import {
  knownAttachmentSearchCandidate,
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
  | "invalid";
export type AttachmentSearchRow = {
  source: AttachmentSearchCandidate;
  state: "queued" | "checking" | "reading" | "searched" | "error" | "skipped";
  code?: AttachmentSearchCode;
  matches: number;
  file?: VerifiedFile;
};
export type AttachmentSearchHit = Readonly<{
  source: AttachmentSearchCandidate;
  file: VerifiedFile;
  before: string;
  match: string;
  after: string;
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
}
const port: AttachmentSearchPort = {
  inspect: (path) => invoke("file_delivery_inspect_text", { path }),
  read: (file) => fileDelivery.readText(file),
  check: (file) => invoke("file_delivery_check_text_revision", { file }),
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
      "invalid",
    ].includes(String(code))
  )
    return code as AttachmentSearchCode;
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
      this.emit({ phase: "cancelling", hits: [], matches: 0 });
    }
  }
  retire() {
    if (this.flight) this.flight.retired = true;
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
    const run = { current, cancelled: false, retired: false };
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
      if (!run.retired) this.row(index, { state: "error", code });
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
      let budget = 0;
      const admitted = new Set<number>();
      for (let i = 0; i < sources.length; i++) {
        const f = checked.get(i);
        if (!f) continue;
        if (budget + f.size > ATTACHMENT_SEARCH_LIMITS.totalBytes) {
          if (valid()) this.row(i, { state: "skipped", code: "budget" });
          continue;
        }
        budget += f.size;
        admitted.add(i);
      }
      const matches = new Map<number, AttachmentSearchHit[]>();
      const counts = new Map<number, number>();
      await pool(async (i) => {
        const f = checked.get(i);
        if (!f || !admitted.has(i) || !valid()) return;
        this.row(i, { state: "reading", file: f });
        try {
          const text = await textPayload(await this.services.read(f), f);
          if (!valid()) return;
          const revision = record(await this.services.check(f));
          if (!valid()) return;
          if (revision.kind !== "verified") fail("changed");
          if (!sameFileRevision(f, file(revision.file, f.path)))
            fail("changed");
          const regex = new RegExp(
            query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "giu",
          );
          let count = 0;
          const hits: AttachmentSearchHit[] = [];
          for (const match of text.matchAll(regex)) {
            count++;
            if (count % 4096 === 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              if (!valid()) return;
            }
            if (hits.length < ATTACHMENT_SEARCH_LIMITS.hits)
              hits.push(
                Object.freeze({
                  source: sources[i],
                  file: f,
                  before: text.slice(
                    Math.max(0, match.index - 56),
                    match.index,
                  ),
                  match: match[0],
                  after: text.slice(
                    match.index + match[0].length,
                    match.index + match[0].length + 88,
                  ),
                }),
              );
          }
          if (!valid()) return;
          matches.set(i, hits);
          counts.set(i, count);
          this.row(i, { state: "searched", matches: count });
          this.emit({ bytes: this.state.bytes + f.size });
        } catch (e) {
          error(i, e);
        }
      });
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
