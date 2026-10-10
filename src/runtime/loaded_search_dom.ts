import { loadedSearchHitField, type LoadedSearchHit } from "./loaded_search";
import { transcriptTextFields } from "./transcript_find_dom";

/** No text-based fallback: duplicate messages/attachments must not borrow a hit. */
export function loadedSearchDOMRange(
  transcript: HTMLElement,
  hit: LoadedSearchHit,
): { range: Range; message: HTMLElement } | null {
  const field = loadedSearchHitField(hit);
  if (!field) return null;
  const messages = [
    ...transcript.querySelectorAll<HTMLElement>("[data-loaded-message]"),
  ].filter((node) => node.dataset.loadedMessage === hit.itemId);
  if (messages.length !== 1) return null;
  const message = messages[0];
  const root =
    hit.attachmentIndex === null
      ? message.querySelector<HTMLElement>("[data-loaded-body]")
      : [...message.querySelectorAll<HTMLElement>("[data-loaded-attachment]")]
          .find(
            (node) =>
              node.dataset.loadedAttachment === String(hit.attachmentIndex),
          )
          ?.querySelector<HTMLElement>("[data-loaded-attachment-text]");
  if (!root) return null;
  const fields = transcriptTextFields(
    root,
    hit.attachmentIndex === null ? ".message-attachments" : undefined,
  );
  const current = fields[field.index];
  if (!current || current.text !== field.text) return null;
  const range = document.createRange();
  let offset = 0,
    start = false,
    end = false;
  for (const node of current.nodes) {
    if (!start && field.start >= offset && field.start < offset + node.length) {
      range.setStart(node, field.start - offset);
      start = true;
    }
    if (!end && field.end > offset && field.end <= offset + node.length) {
      range.setEnd(node, field.end - offset);
      end = true;
    }
    offset += node.length;
  }
  return start && end && range.toString() === hit.match
    ? { range, message }
    : null;
}
