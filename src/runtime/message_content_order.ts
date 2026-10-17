/** In-memory presentation ranges into the existing message body and attachments.
 * Adjacent chunks merge; these are neither copied payloads nor stored events.
 * Only the projection creates them. Missing legacy order stays unknown.
 */
export type MessageContentOrderPart = Readonly<{
  kind: "text" | "attachments";
  start: number;
  end: number;
}>;

export function appendMessageContentPart(
  order: readonly MessageContentOrderPart[] | undefined,
  part: MessageContentOrderPart,
): readonly MessageContentOrderPart[] | undefined {
  if (!order || part.start === part.end) return order;
  const last = order.at(-1);
  return last?.kind === part.kind && last.end === part.start
    ? [...order.slice(0, -1), { ...last, end: part.end }]
    : [...order, part];
}

/** Require complete, nonduplicated coverage of both existing channels before
 * rendering their known order. Invalid or absent metadata keeps the full
 * legacy presentation; it must never silently hide existing content.
 */
export function checkedMessageContentOrder(
  textLength: number,
  attachmentCount: number,
  order: readonly MessageContentOrderPart[] | undefined,
): readonly MessageContentOrderPart[] | null {
  if (!order) return null;
  let text = 0,
    attachments = 0;
  for (const part of order) {
    if (
      !Number.isSafeInteger(part.start) ||
      !Number.isSafeInteger(part.end) ||
      part.end <= part.start
    )
      return null;
    if (part.kind === "text") {
      if (part.start !== text || part.end > textLength) return null;
      text = part.end;
    } else if (part.kind === "attachments") {
      if (part.start !== attachments || part.end > attachmentCount) return null;
      attachments = part.end;
    } else return null;
  }
  return text === textLength && attachments === attachmentCount ? order : null;
}
