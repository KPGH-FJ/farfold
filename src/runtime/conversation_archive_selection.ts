import { fileDelivery, type VerifiedFile } from "./file_delivery";
import {
  ARCHIVE_LIMITS,
  archiveUuid,
  binarySize,
  utf8Size,
  archiveInput,
} from "./conversation_archive_input";
import { archiveCode } from "./conversation_archive_parse";
import {
  archiveDisplay,
  archiveMember,
  archiveMarkdownLabel,
  type ArchiveCandidate,
  type ConversationExportSnapshot,
} from "./conversation_archive_snapshot";
import type {
  ArchiveSource,
  ArchiveOmission,
  ArchiveCode,
  ArchivePrepareInput,
} from "./conversation_archive_types";
export interface SelectionRow {
  candidate: ArchiveCandidate;
  state: "unchecked" | "checking" | "selected" | "error";
  source?: ArchiveSource;
  code?: ArchiveCode;
  omission?: ArchiveOmission;
}
export class ArchiveSelection {
  private rows: SelectionRow[];
  private listeners = new Set<() => void>();
  private attempts = new Map<string, object>();
  private alive = true;
  private inspections = 0;
  private revision = archiveUuid();
  constructor(
    private capture: ConversationExportSnapshot | null,
    private inspect = fileDelivery.inspectLink,
  ) {
    this.rows = capture!.candidates.map((candidate) => ({
      candidate,
      state: "unchecked",
    }));
  }
  getSnapshot = () => this.rows;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  activate = () => {
    this.alive = true;
  };
  version = () => this.revision;
  retire = () => {
    this.alive = false;
    this.attempts.clear();
    this.revision = archiveUuid();
  };
  releasePayload = () => {
    this.retire();
    this.capture = null;
    this.rows = [];
    this.listeners.forEach((fn) => fn());
  };
  private change(id: string, update: Partial<SelectionRow>) {
    this.revision = archiveUuid();
    this.rows = this.rows.map((row) =>
      row.candidate.candidateId === id ? { ...row, ...update } : row,
    );
    this.listeners.forEach((fn) => fn());
  }
  isCurrent = () => this.alive;
  private removeReplacements(original: string) {
    for (const row of this.rows)
      if (row.candidate.replacesCandidateId === original)
        this.attempts.delete(row.candidate.candidateId);
    this.rows = this.rows.filter(
      (row) => row.candidate.replacesCandidateId !== original,
    );
  }
  private async inspectBounded(cwd: string, path: string) {
    if (this.inspections >= 2) throw { code: "busy" };
    this.inspections++;
    try {
      return await this.inspect(cwd, path);
    } finally {
      this.inspections--;
    }
  }
  async select(id: string, selected: boolean) {
    if (!this.alive) return;
    const row = this.rows.find((r) => r.candidate.candidateId === id);
    if (!row) return;
    if (row.candidate.replacesCandidateId) {
      const original = row.candidate.replacesCandidateId;
      if (!selected) {
        this.removeReplacements(original);
        this.change(original, {
          state: "unchecked",
          source: undefined,
          code: undefined,
          omission: undefined,
        });
      }
      return;
    }
    this.removeReplacements(id);
    const attempt = {};
    this.attempts.set(id, attempt);
    if (!selected) {
      this.change(id, {
        state: "unchecked",
        source: undefined,
        code: undefined,
        omission: undefined,
      });
      return;
    }
    this.change(id, {
      state: "checking",
      source: undefined,
      code: undefined,
      omission: undefined,
    });
    try {
      const raw = row.candidate.source;
      let source: ArchiveSource;
      if (raw.kind === "unavailable") throw { code: "invalidData" };
      if (raw.kind === "local")
        source = {
          kind: "local",
          file: await this.inspectBounded(raw.cwd, raw.path),
          selectedBy: "declaredSource",
        };
      else if (raw.kind === "inlineText")
        source = {
          kind: "inlineText",
          text: raw.text,
          utf8Bytes: utf8Size(raw.text),
        };
      else
        source = {
          kind: "inlineBinary",
          base64: raw.base64,
          decodedBytes: binarySize(raw.base64),
        };
      validateSource(source);
      if (this.alive && this.attempts.get(id) === attempt)
        this.change(id, { state: "selected", source });
    } catch (error) {
      if (this.alive && this.attempts.get(id) === attempt)
        this.change(id, { state: "error", code: archiveCode(error) });
    }
  }
  async replace(id: string, path: string) {
    if (!this.alive) return;
    const initial = this.rows.find((r) => r.candidate.candidateId === id);
    if (!initial) return;
    id = initial.candidate.replacesCandidateId ?? id;
    const row = this.rows.find((r) => r.candidate.candidateId === id);
    if (!row) return;
    const attempt = {};
    this.attempts.set(id, attempt);
    this.change(id, { state: "checking", code: undefined });
    try {
      const file = await this.inspectBounded("", path);
      const source: ArchiveSource = {
        kind: "local",
        file,
        selectedBy: "filePickerSubstitute",
      };
      validateSource(source);
      if (!this.alive || this.attempts.get(id) !== attempt) return;
      if (
        this.rows.filter((r) => r.candidate.replacesCandidateId !== id)
          .length >= ARCHIVE_LIMITS.candidates
      )
        throw { code: "tooLarge" };
      const candidate: ArchiveCandidate = {
        ...row.candidate,
        candidateId: archiveUuid(),
        displayName: archiveDisplay(file.name),
        representation: "localCurrentFile",
        replacesCandidateId: id,
        source: { kind: "local", cwd: file.root, path: file.path },
      };
      this.removeReplacements(id);
      this.rows = [...this.rows, { candidate, state: "selected", source }];
      this.change(id, {
        state: "unchecked",
        source: undefined,
        code: undefined,
        omission: "replacedByUserSelection",
      });
    } catch (error) {
      if (this.alive && this.attempts.get(id) === attempt)
        this.change(id, { state: "error", code: archiveCode(error) });
    }
  }
  async prepare(
    destination: string,
    current: () => boolean,
    includeDetails = false,
  ): Promise<ArchivePrepareInput | null> {
    if (!this.alive || !current() || !this.capture) return null;
    if (
      includeDetails
        ? this.capture.unavailable.archiveDetails
        : this.capture.unavailable.archive
    )
      throw { code: "tooLarge" };
    if (this.rows.some((r) => r.state === "checking" || r.state === "error"))
      throw { code: "invalidData" };
    const revision = this.revision;
    const selected = this.rows
      .filter((r) => r.state === "selected" && r.source)
      .map((r) => ({
        candidateId: r.candidate.candidateId,
        source: r.source!,
      }));
    const total = selected.reduce((n, s) => n + sourceBytes(s.source), 0);
    const inline = selected
      .filter((s) => s.source.kind !== "local")
      .reduce((n, s) => n + sourceBytes(s.source), 0);
    if (
      selected.length > ARCHIVE_LIMITS.selected ||
      total > ARCHIVE_LIMITS.total ||
      inline > ARCHIVE_LIMITS.inline
    )
      throw { code: "tooLarge" };
    const links = selected.map(
      (s, i) =>
        `- [${archiveMarkdownLabel(this.rows.find((r) => r.candidate.candidateId === s.candidateId)!.candidate.displayName || "附件")}](${archiveMember(i, s.source.kind === "inlineText", this.rows.find((r) => r.candidate.candidateId === s.candidateId)!.candidate.displayName)})`,
    );
    const markdown =
      (includeDetails
        ? this.capture.detailedArchiveMarkdown
        : this.capture.archiveMarkdown) +
      "\n\n## 所选附件\n\n" +
      (links.join("\n") || "未选择附件。") +
      "\n";
    if (utf8Size(markdown) > ARCHIVE_LIMITS.markdown)
      throw { code: "tooLarge" };
    const input = await archiveInput({
      operationId: archiveUuid(),
      snapshotId: this.capture.snapshotId,
      selectionId: revision,
      destination,
      markdown,
      candidates: this.rows.map(
        ({ candidate: { source: _, ...metadata } }) => metadata,
      ),
      selected,
      omitted: this.rows
        .filter((r) => r.state !== "selected")
        .map((r) => ({
          candidateId: r.candidate.candidateId,
          reason:
            r.omission ??
            (r.candidate.source.kind === "unavailable"
              ? r.candidate.source.reason
              : "notSelected"),
        })),
    });
    return this.alive && current() && this.revision === revision ? input : null;
  }
}
export function sourceBytes(s: ArchiveSource): number {
  return s.kind === "local"
    ? s.file.size
    : s.kind === "inlineText"
      ? s.utf8Bytes
      : s.decodedBytes;
}
function validateSource(source: ArchiveSource) {
  const bytes = sourceBytes(source);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw { code: "invalidData" };
  if (
    bytes >
    (source.kind === "local" ? ARCHIVE_LIMITS.local : ARCHIVE_LIMITS.inline)
  )
    throw { code: "tooLarge" };
  if (source.kind === "local") {
    const f: VerifiedFile = source.file;
    if (
      !f ||
      [f.root, f.path, f.resolvedPath, f.name, f.version].some(
        (s) => typeof s !== "string" || !s,
      ) ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw { code: "invalidData" };
  }
}
