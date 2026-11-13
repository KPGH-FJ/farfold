import {
  attachmentMediaAdmission,
  MAX_MESSAGE_MEDIA_BYTES,
  normalizeMessageAttachment,
  sameOfficialAttachment,
} from "./message_attachments";
import type {
  Attachment,
  ThreadState,
  ToolCallView,
  ToolContent,
} from "./session_types";

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const identity = (s: ThreadState) =>
  JSON.stringify([s.key, s.agentId, s.cwd, s.nativeSessionId, s.connectionId]);
interface Source {
  call: ToolCallView;
  content: ToolContent[];
  identity: string;
  owns?: () => boolean;
}
// Only the immediately preceding actual tool projection can receive the local
// supplement. No body copy, transcript, or persistent event history is kept.
const next = new WeakMap<ThreadState, Source>();
const supplemental = new WeakSet<ToolContent>();

/** Retire only our appended blocks on a new call/result. Explicit ACP content
 * replacement remains authoritative; omitted/null content retains its value. */
export function clearToolMedia(call: ToolCallView): void {
  if (call.content.some((c) => supplemental.has(c)))
    call.content = call.content.filter((c) => !supplemental.has(c));
}

export function rememberToolMediaSource(
  s: ThreadState,
  event: Record<string, unknown>,
  call: ToolCallView | undefined,
  owns?: () => boolean,
  deliveryConnectionId?: string,
): void {
  const update = event.update;
  if (
    !call ||
    !record(update) ||
    Object.hasOwn(event, "kind") ||
    Object.hasOwn(event, "method") ||
    event.sessionId !== s.nativeSessionId ||
    !["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) ||
    update.status !== "completed" ||
    update.toolCallId !== call.toolCallId ||
    call.status !== "completed" ||
    !s.connectionId ||
    s.connectionLost ||
    (owns && !owns()) ||
    (deliveryConnectionId !== undefined &&
      deliveryConnectionId !== s.connectionId)
  )
    return;
  next.set(s, { call, content: call.content, identity: identity(s), owns });
}

/** The backend emits this local event directly after the unchanged source
 * update; arbitrary Agent notifications and nested presentation fields are not
 * this channel. Every intervening event consumes the one pending association. */
export function receiveToolMedia(
  s: ThreadState,
  event: unknown,
  owns?: () => boolean,
  deliveryConnectionId?: string,
): boolean {
  const source = next.get(s);
  next.delete(s);
  if (
    !source ||
    !record(event) ||
    !exact(event, [
      "kind",
      "connectionId",
      "sessionId",
      "toolCallId",
      "content",
    ]) ||
    event.kind !== "toolMedia" ||
    !s.connectionId ||
    event.connectionId !== s.connectionId ||
    event.sessionId !== s.nativeSessionId ||
    event.toolCallId !== source.call.toolCallId ||
    source.identity !== identity(s) ||
    s.connectionLost ||
    (source.owns && !source.owns()) ||
    (owns && !owns()) ||
    (deliveryConnectionId !== undefined &&
      deliveryConnectionId !== s.connectionId) ||
    source.call.status !== "completed" ||
    source.call.content !== source.content ||
    !s.items.some(
      (item) => item.kind === "tool" && item.call === source.call,
    ) ||
    !Array.isArray(event.content) ||
    !event.content.length ||
    event.content.length > 16
  )
    return false;
  let total = 0;
  for (const block of event.content) {
    if (
      !record(block) ||
      !exact(block, ["type", "mimeType", "data"]) ||
      block.type !== "image" ||
      ![
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
      ].includes(String(block.mimeType)) ||
      typeof block.data !== "string"
    )
      return false;
    total += block.data.length;
    if (total > 4 * Math.ceil(MAX_MESSAGE_MEDIA_BYTES / 3)) return false;
  }
  // Keep the common codec/size/pixel gate. No image URL or partial supplement
  // is created if any declared block is not safe to preview.
  const attachments: Attachment[] = [];
  for (const block of event.content) {
    const attachment = normalizeMessageAttachment(block);
    if (
      !attachment ||
      attachmentMediaAdmission(attachment).status !== "available"
    )
      return false;
    attachments.push(attachment);
  }
  const content = [...source.call.content];
  for (const attachment of attachments) {
    if (
      content.some(
        (c) =>
          c.type === "attachment" &&
          sameOfficialAttachment(c.attachment, attachment),
      )
    )
      continue;
    const block: ToolContent = { type: "attachment", attachment };
    supplemental.add(block);
    content.push(block);
  }
  source.call.content = content;
  return true;
}
