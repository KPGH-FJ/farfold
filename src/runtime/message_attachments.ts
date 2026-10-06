import type { Attachment, ThreadItem } from "./session_types";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Accept only declared message content types with their required payload.
 * Unknown envelopes remain raw and never qualify as readable conversation. */
export function normalizeMessageAttachment(
  content: unknown,
): Attachment | null {
  const c = record(content);
  if (!c) return null;
  if (c.type === "image" || c.type === "audio") {
    const data = nonempty(c.data);
    const mimeType = nonempty(c.mimeType);
    if (!data || !mimeType) return null;
    return {
      kind: c.type,
      name: c.type === "image" ? "图片" : "音频",
      data,
      mimeType,
      uri: nonempty(c.uri),
    };
  }
  if (c.type === "resource_link") {
    const uri = nonempty(c.uri);
    const name = nonempty(c.name);
    return uri && name
      ? { kind: "resource_link", name, uri, mimeType: nonempty(c.mimeType) }
      : null;
  }
  if (c.type === "resource") {
    const resource = record(c.resource);
    const uri = nonempty(resource?.uri);
    if (
      !resource ||
      !uri ||
      (typeof resource.text !== "string" && !nonempty(resource.blob))
    )
      return null;
    return {
      kind: "resource",
      name: uri.split("/").filter(Boolean).at(-1) ?? uri,
      uri,
      mimeType: nonempty(resource.mimeType),
      text: typeof resource.text === "string" ? resource.text : undefined,
      data: nonempty(resource.blob),
    };
  }
  return null;
}

export function normalizeMessageAttachments(
  content: readonly unknown[],
): Attachment[] {
  return content
    .map(normalizeMessageAttachment)
    .filter((attachment): attachment is Attachment => attachment !== null);
}

export function hasReadableMessages(items: readonly ThreadItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === "user" || item.kind === "agent") &&
      (item.text.trim().length > 0 ||
        (item.attachments ?? []).some(
          (attachment) =>
            !!attachment.name.trim() &&
            !!(attachment.uri || attachment.data || attachment.text),
        )),
  );
}

/** Media is embedded only for recognized inert media formats. Remote resource
 * links remain explicit links; they are never fetched by rendering a message. */
export function attachmentMedia(
  attachment: Attachment,
): { kind: "image" | "audio"; src: string } | null {
  if (!attachment.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data))
    return null;
  const mime = attachment.mimeType?.toLowerCase();
  if (mime && /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(mime))
    return { kind: "image", src: `data:${mime};base64,${attachment.data}` };
  if (
    mime &&
    /^audio\/(?:mpeg|mp3|mp4|ogg|wav|wave|x-wav|webm|flac|aac)$/.test(mime)
  )
    return { kind: "audio", src: `data:${mime};base64,${attachment.data}` };
  return null;
}
