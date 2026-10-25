import { localResourcePath, type VerifiedFile } from "./file_delivery";
import { documentMediaFormat } from "./document_media_type";
import type { Attachment, ThreadItem, ThreadState } from "./session_types";

type Message = Extract<ThreadItem, { kind: "user" | "agent" }>;
export interface AttachmentSearchCandidate {
  readonly id: string;
  readonly threadKey: string;
  readonly itemId: string;
  readonly attachmentIndex: number;
  readonly role: "user" | "agent";
  readonly name: string;
  readonly mimeType?: string;
  readonly path: string | null;
}
interface Owner {
  thread: ThreadState;
  item: Message;
  attachment: Attachment;
  uri: string | undefined;
  name: string;
  mimeType: string | undefined;
  cwd: string;
  agentId: string;
  nativeSessionId: string;
}
const owners = new WeakMap<AttachmentSearchCandidate, Owner>();
/** Declaration only. No filesystem read, inferred path, or Agent operation. */
export function attachmentSearchCandidates(
  keys: readonly string[],
  states: ReadonlyMap<string, ThreadState>,
) {
  const candidates: AttachmentSearchCandidate[] = [];
  let unloaded = 0,
    unavailable = 0,
    omitted = 0;
  for (const key of new Set(keys)) {
    const thread = states.get(key);
    if (!thread) {
      unloaded++;
      continue;
    }
    if (thread.historyUnavailable || thread.reconnecting) {
      unavailable++;
      continue;
    }
    for (const item of thread.items) {
      if (item.kind !== "user" && item.kind !== "agent") continue;
      item.attachments?.forEach((attachment, attachmentIndex) => {
        if (candidates.length >= 1000) {
          omitted++;
          return;
        }
        const candidate = Object.freeze({
          id: JSON.stringify([key, item.id, attachmentIndex]),
          threadKey: key,
          itemId: item.id,
          attachmentIndex,
          role: item.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          path: attachment.uri ? localResourcePath(attachment.uri) : null,
        });
        owners.set(candidate, {
          thread,
          item,
          attachment,
          uri: attachment.uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
          cwd: thread.cwd,
          agentId: thread.agentId,
          nativeSessionId: thread.nativeSessionId,
        });
        candidates.push(candidate);
      });
    }
  }
  return { candidates, unloaded, unavailable, omitted };
}
export function attachmentSearchSourceCurrent(
  candidate: AttachmentSearchCandidate,
  states: ReadonlyMap<string, ThreadState>,
  keys?: readonly string[],
  index?: readonly {
    id: string;
    agentId: string;
    cwd: string;
    nativeSessionId: string | null;
  }[],
): boolean {
  const owner = owners.get(candidate);
  if (!owner || (keys && !keys.includes(candidate.threadKey))) return false;
  const thread = states.get(candidate.threadKey);
  const rows = index?.filter((row) => row.id === candidate.threadKey);
  if (
    rows &&
    (rows.length !== 1 ||
      !thread ||
      rows[0].agentId !== thread.agentId ||
      rows[0].cwd !== thread.cwd ||
      rows[0].nativeSessionId !== thread.nativeSessionId)
  )
    return false;
  return (
    !!thread &&
    thread === owner.thread &&
    !thread.historyUnavailable &&
    !thread.reconnecting &&
    thread.cwd === owner.cwd &&
    thread.agentId === owner.agentId &&
    thread.nativeSessionId === owner.nativeSessionId &&
    thread.items.filter((i) => i.id === candidate.itemId).length === 1 &&
    thread.items.includes(owner.item) &&
    owner.item.attachments?.[candidate.attachmentIndex] === owner.attachment &&
    owner.attachment.uri === owner.uri &&
    owner.attachment.name === owner.name &&
    owner.attachment.mimeType === owner.mimeType
  );
}

/** Type declarations select a parser, never authorize or validate its contents. */
export function attachmentSearchIsDocx(source: AttachmentSearchCandidate) {
  return (
    documentMediaFormat(source.mimeType) === "docx" ||
    /\.docx$/i.test(source.path ?? "")
  );
}
export function attachmentSearchIsXlsx(source: AttachmentSearchCandidate) {
  // Preserve the existing DOCX route when declarations conflict. The actual
  // captured package must still validate; there is no parser/link fallback.
  return (
    !attachmentSearchIsDocx(source) &&
    (documentMediaFormat(source.mimeType) === "xlsx" ||
      /\.xlsx$/i.test(source.path ?? ""))
  );
}
export function attachmentSearchIsPdf(source: AttachmentSearchCandidate) {
  // Keep existing DOCX/XLSX declaration precedence. A selected parser must
  // validate the captured bytes; failures never fall back to raw text.
  return (
    !attachmentSearchIsDocx(source) &&
    !attachmentSearchIsXlsx(source) &&
    (documentMediaFormat(source.mimeType) === "pdf" ||
      /\.pdf$/i.test(source.path ?? ""))
  );
}
export function attachmentSearchIsPptx(source: AttachmentSearchCandidate) {
  // Keep the established document routing precedence. This declaration never
  // grants scope, identifies bytes or enables PPTX as Agent input.
  const essence =
    typeof source.mimeType === "string"
      ? source.mimeType
          .split(";", 1)[0]
          .replace(/^[ \t]+|[ \t]+$/g, "")
          .toLowerCase()
      : undefined;
  return (
    !attachmentSearchIsDocx(source) &&
    !attachmentSearchIsXlsx(source) &&
    !attachmentSearchIsPdf(source) &&
    (essence ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      /\.pptx$/i.test(source.path ?? ""))
  );
}
/** A location request contains no file text and never pretends it is message text. */
export type AttachmentSearchLocation = AttachmentSearchCandidate;
/** A transient page request for this exact searched file, never reading history. */
export type AttachmentPdfPreview = Readonly<{
  file: Readonly<VerifiedFile>;
  pageNumber: number;
}>;
export type AttachmentPdfPreviewTarget = AttachmentPdfPreview & {
  current: () => boolean;
};
export type SelectAttachmentSearch = (
  source: AttachmentSearchLocation,
  current: () => boolean,
  pdfPreview?: AttachmentPdfPreview,
) => void;

export function knownAttachmentSearchCandidate(
  candidate: AttachmentSearchCandidate,
): boolean {
  return owners.has(candidate);
}
