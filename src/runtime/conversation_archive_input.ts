import type {
  ArchivePrepareInput,
  ArchiveSource,
} from "./conversation_archive_types";
export const ARCHIVE_LIMITS = {
  candidates: 4096,
  selected: 256,
  markdown: 1024 * 1024,
  inline: 16 * 1024 * 1024,
  request: 32 * 1024 * 1024,
  total: 1024 * 1024 * 1024,
  local: 256 * 1024 * 1024,
} as const;
export const archiveUuid = () => crypto.randomUUID();
export function scalar(value: string): string {
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    throw { code: "invalidData" };
  return value;
}
export const utf8Size = (s: string) =>
  new TextEncoder().encode(scalar(s)).length;
export function binarySize(data: string): number {
  if (
    data.length > Math.ceil(ARCHIVE_LIMITS.inline / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  )
    throw { code: "invalidData" };
  const bytes = atob(data);
  if (btoa(bytes) !== data) throw { code: "invalidData" };
  return bytes.length;
}
function sourceTuple(source: ArchiveSource) {
  if (source.kind === "local") {
    const f = source.file;
    return [
      "local",
      [f.root, f.path, f.resolvedPath, f.name, f.size, f.sha256, f.version],
      source.selectedBy,
    ];
  }
  return source.kind === "inlineText"
    ? ["inlineText", source.text, source.utf8Bytes]
    : ["inlineBinary", source.base64, source.decodedBytes];
}
function checked(value: unknown): void {
  if (typeof value === "string") scalar(value);
  else if (
    typeof value === "number" &&
    (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
  )
    throw { code: "invalidData" };
  else if (Array.isArray(value)) value.forEach(checked);
}
export function archiveCanonical(
  input: Omit<ArchivePrepareInput, "inputSha256">,
): string {
  const tuple = [
    "farfold.conversationArchive.v1",
    input.snapshotId,
    input.selectionId,
    input.destination,
    input.markdown,
    input.candidates.map((c) => [
      c.candidateId,
      [
        c.origin.itemOrdinal,
        c.origin.role,
        c.origin.attachmentOrdinal,
        c.origin.toolContentOrdinal,
        c.origin.declaration,
      ],
      c.displayName,
      c.declaredMimeType,
      c.representation,
      c.replacesCandidateId,
    ]),
    input.selected.map((s) => [s.candidateId, sourceTuple(s.source)]),
    input.omitted.map((o) => [o.candidateId, o.reason]),
  ];
  checked(tuple);
  const value = JSON.stringify(tuple);
  if (utf8Size(value) > ARCHIVE_LIMITS.request) throw { code: "tooLarge" };
  return value;
}
export async function archiveInput(
  input: Omit<ArchivePrepareInput, "inputSha256">,
): Promise<ArchivePrepareInput> {
  const bytes = new TextEncoder().encode(archiveCanonical(input));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return {
    ...input,
    inputSha256: [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  };
}
