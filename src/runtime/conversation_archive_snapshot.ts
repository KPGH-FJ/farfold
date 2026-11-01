import type { Attachment, ThreadItem } from "./session_types";
import { transcriptMarkdown } from "./conversation_export";
import { localResourcePath, reportedFileSources } from "./file_delivery";
import { fileBasename } from "./file_paths";
import {
  ARCHIVE_LIMITS,
  archiveUuid,
  scalar,
  utf8Size,
} from "./conversation_archive_input";
import type {
  ArchiveCandidateMetadata,
  ArchiveOrigin,
  ArchiveOmission,
} from "./conversation_archive_types";
export type CandidateSource =
  | { kind: "local"; cwd: string; path: string }
  | { kind: "inlineText"; text: string }
  | { kind: "inlineBinary"; base64: string }
  | { kind: "unavailable"; reason: ArchiveOmission };
export interface ArchiveCandidate extends ArchiveCandidateMetadata {
  source: CandidateSource;
}
export interface ConversationExportSnapshot {
  snapshotId: string;
  markdown: string;
  archiveMarkdown: string;
  detailedMarkdown: string;
  detailedArchiveMarkdown: string;
  toolDetailCount: number;
  unavailable: {
    markdown: boolean;
    archive: boolean;
    details: boolean;
    archiveDetails: boolean;
  };
  candidates: readonly ArchiveCandidate[];
}
export const hasExportableContent = (thread: { items: ThreadItem[] }) =>
  !!transcriptMarkdown(thread, "", "")
    .replace(/^#\s.*$/m, "")
    .trim();
/** Metadata-only display escaping is not privacy filtering of body or filenames. */
export function archiveDisplay(value: string, limit = 1024): string {
  scalar(value);
  let result = "";
  for (const char of value.replace(/[\u0000-\u001f\u007f]/g, " ")) {
    if (utf8Size(result + char) > limit) break;
    result += char;
  }
  return result;
}
function local(uri: string): string | null {
  if (/^file:/i.test(uri)) return localResourcePath(uri);
  return uri &&
    !/[\u0000-\u001f\u007f]/.test(uri) &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(uri) || /^[a-z]:[\\/]/i.test(uri)) &&
    !uri.startsWith("//")
    ? uri
    : null;
}
/** Pure immutable capture. No file inspection, history load or URL read. */
export function captureConversationExport(
  thread: { items: ThreadItem[]; cwd: string },
  title: string,
  agentName: string,
): ConversationExportSnapshot {
  if (!hasExportableContent(thread)) throw { code: "empty" };
  const candidates: ArchiveCandidate[] = [];
  let tooManyCandidates = false;
  const add = (
    name: string,
    mime: string | undefined,
    origin: ArchiveOrigin,
    source: CandidateSource,
  ) => {
    if (candidates.length >= ARCHIVE_LIMITS.candidates) {
      tooManyCandidates = true;
      return;
    }
    candidates.push({
      candidateId: archiveUuid(),
      origin: { ...origin },
      displayName: archiveDisplay(name),
      declaredMimeType: mime ? archiveDisplay(mime, 256) : null,
      representation:
        source.kind === "local"
          ? "localCurrentFile"
          : source.kind === "inlineText"
            ? "receivedText"
            : source.kind === "inlineBinary"
              ? "receivedBytes"
              : "referenceOnly",
      replacesCandidateId: null,
      source,
    });
  };
  const attachment = (a: Attachment, origin: ArchiveOrigin) => {
    if (a.text !== undefined)
      add(a.name, a.mimeType, origin, { kind: "inlineText", text: a.text });
    if (a.data !== undefined)
      add(a.name, a.mimeType, origin, { kind: "inlineBinary", base64: a.data });
    if (a.uri) {
      const path = local(a.uri);
      add(
        a.name,
        a.mimeType,
        origin,
        path
          ? { kind: "local", path, cwd: thread.cwd }
          : {
              kind: "unavailable",
              reason: /^(https?:)?\/\//i.test(a.uri)
                ? "remoteNotFetched"
                : "unsupportedSource",
            },
      );
    } else if (a.text === undefined && a.data === undefined)
      add(a.name, a.mimeType, origin, {
        kind: "unavailable",
        reason: "missingPayload",
      });
  };
  thread.items.forEach((item, itemOrdinal) => {
    if (item.kind === "user" || item.kind === "agent") {
      item.attachments?.forEach((a, attachmentOrdinal) =>
        attachment(a, {
          itemOrdinal,
          role: item.kind,
          attachmentOrdinal,
          toolContentOrdinal: null,
          declaration: "messageAttachment",
        }),
      );
      return;
    }
    if (item.kind !== "tool") return;
    item.call.content.forEach((c, toolContentOrdinal) => {
      const origin: ArchiveOrigin = {
        itemOrdinal,
        role: "tool",
        attachmentOrdinal: null,
        toolContentOrdinal,
        declaration:
          c.type === "attachment" ? "toolAttachment" : "resourceLink",
      };
      if (c.type === "attachment") attachment(c.attachment, origin);
      if (c.type === "link") attachment({ name: c.name, uri: c.uri }, origin);
    });
    for (const report of reportedFileSources(item.call).filter(
      (r) => r.source !== "resourceLink",
    ))
      add(
        fileBasename(report.path),
        undefined,
        {
          itemOrdinal,
          role: "tool",
          attachmentOrdinal: null,
          toolContentOrdinal: null,
          declaration: "reportedFile",
        },
        { kind: "local", cwd: thread.cwd, path: report.path },
      );
  });
  const markdown = transcriptMarkdown(thread, title, agentName);
  const detailInputBytes = thread.items.reduce(
    (n, item) =>
      n +
      (item.kind === "tool"
        ? item.call.content.reduce(
            (v, c) =>
              v +
              (c.type === "text"
                ? utf8Size(c.text)
                : c.type === "diff"
                  ? utf8Size(c.oldText ?? "") + utf8Size(c.newText)
                  : 0),
            utf8Size(item.call.terminalOutput ?? "") +
              utf8Size(item.call.streamedOutput?.text ?? ""),
          )
        : 0),
    0,
  );
  const detailsTooLarge = detailInputBytes > ARCHIVE_LIMITS.markdown;
  const detailedMarkdown = detailsTooLarge
    ? ""
    : transcriptMarkdown(thread, title, agentName, {
        includeLoadedToolDetails: true,
      });
  const archiveMarkdown = transcriptMarkdown(thread, title, agentName, {
    sourceLocations: "omit",
    attachmentScope: "selectedArchive",
  });
  const detailedArchiveMarkdown = detailsTooLarge
    ? ""
    : transcriptMarkdown(thread, title, agentName, {
        sourceLocations: "omit",
        attachmentScope: "selectedArchive",
        includeLoadedToolDetails: true,
      });
  const unavailable = {
    markdown: utf8Size(markdown) > ARCHIVE_LIMITS.markdown,
    archive:
      tooManyCandidates || utf8Size(archiveMarkdown) > ARCHIVE_LIMITS.markdown,
    details:
      detailsTooLarge || utf8Size(detailedMarkdown) > ARCHIVE_LIMITS.markdown,
    archiveDetails:
      tooManyCandidates ||
      detailsTooLarge ||
      utf8Size(detailedArchiveMarkdown) > ARCHIVE_LIMITS.markdown,
  };
  const toolDetailCount = thread.items.reduce(
    (n, item) =>
      n +
      (item.kind === "tool"
        ? item.call.content.filter(
            (c) => c.type === "text" || c.type === "diff",
          ).length +
          (item.call.terminalOutput !== undefined ? 1 : 0) +
          (item.call.streamedOutput !== undefined ? 1 : 0)
        : 0),
    0,
  );
  return {
    snapshotId: archiveUuid(),
    markdown,
    archiveMarkdown,
    detailedMarkdown,
    detailedArchiveMarkdown,
    toolDetailCount,
    unavailable,
    candidates,
  };
}
const ordinaryExtensions = new Set(
  "pdf png jpg jpeg gif webp txt md csv json docx xlsx pptx odt ods odp mp3 wav m4a mp4 mov webm zip".split(
    " ",
  ),
);
/** Filename hint only: not MIME validation; metadata never becomes a ZIP path. */
export function archiveMember(
  index: number,
  text: boolean,
  displayName: string,
): string {
  const hint = /\.([a-zA-Z0-9]+)$/.exec(displayName)?.[1].toLowerCase();
  const suffix = text
    ? "txt"
    : hint && ordinaryExtensions.has(hint)
      ? hint
      : "bin";
  return `attachments/${String(index + 1).padStart(4, "0")}.${suffix}`;
}
export const archiveMarkdownLabel = (value: string) =>
  value.replace(/[\\`*_{}\[\]()#+.!<>|~-]/g, "\\$&");

/** Drop only this export capture; the conversation itself is untouched. */
export function releasedExportSnapshot(
  snapshot: ConversationExportSnapshot,
): ConversationExportSnapshot {
  return {
    snapshotId: snapshot.snapshotId,
    markdown: "",
    archiveMarkdown: "",
    detailedMarkdown: "",
    detailedArchiveMarkdown: "",
    toolDetailCount: 0,
    unavailable: {
      markdown: true,
      archive: true,
      details: true,
      archiveDetails: true,
    },
    candidates: [],
  };
}
