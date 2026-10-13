export type DocumentMediaFormat = "docx" | "xlsx" | "pdf";

const formats: Record<string, DocumentMediaFormat> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** Media type essence only identifies a candidate. It grants no source authority
 * and never rewrites the original official MIME, saved text, or wire payload. */
export function documentMediaFormat(
  mimeType: unknown,
): DocumentMediaFormat | undefined {
  if (typeof mimeType !== "string") return undefined;
  const essence = mimeType.split(";", 1)[0].replace(/^[ \t]+|[ \t]+$/g, "");
  const normalized = essence.replace(/[A-Z]/g, (letter) =>
    letter.toLowerCase(),
  );
  return Object.hasOwn(formats, normalized) ? formats[normalized] : undefined;
}
