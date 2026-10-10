import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CaretDown, Paperclip } from "@phosphor-icons/react";
import {
  textImageParts,
  type TextImagePart,
} from "../runtime/text_image_links";
import { validateDraftImage, type DraftImage } from "../runtime/draft_images";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";
import "../message-attachments.css";

type TextImage = Extract<TextImagePart, { kind: "image" }>;

/** Checking begins only on explicit expansion, with the existing shared caps.
 * Neither a closed attachment nor a late check can introduce an img decoder. */
export function TextMessageImage({ image }: { image: TextImage }) {
  const [expanded, setExpanded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState<DraftImage | null>(null);
  const request = useRef(0);
  const pending = useRef(false);
  useLayoutEffect(() => {
    ++request.current;
    pending.current = false;
    setExpanded(false);
    setChecking(false);
    setFailed(false);
    setChecked(null);
    return () => {
      ++request.current;
      pending.current = false;
    };
  }, [image.data, image.mimeType]);
  const current =
    checked?.data === image.data && checked.mimeType === image.mimeType
      ? checked
      : null;
  const toggle = async (open: boolean) => {
    setExpanded(open);
    if (!open) {
      ++request.current;
      pending.current = false;
      setChecking(false);
      return;
    }
    if (current || pending.current) return;
    const id = ++request.current;
    pending.current = true;
    setChecking(true);
    setFailed(false);
    try {
      const result = await validateDraftImage(image.data, image.mimeType);
      if (request.current === id) setChecked(result);
    } catch {
      if (request.current === id) setFailed(true);
    } finally {
      if (request.current === id) {
        pending.current = false;
        setChecking(false);
      }
    }
  };
  return (
    <div
      className="message-attachments"
      role="group"
      aria-label={S.label}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Backspace")
          event.stopPropagation();
      }}
    >
      <details
        className="message-attachment"
        open={expanded}
        onToggle={(event) => void toggle(event.currentTarget.open)}
      >
        <summary>
          <Paperclip size={14} aria-hidden="true" />
          <span className="message-attachment-name">{S.historyImage}</span>
          <CaretDown
            className="message-attachment-chevron"
            size={12}
            aria-hidden="true"
          />
        </summary>
        {expanded && (
          <figure className="message-attachment-content">
            <figcaption>{image.mimeType}</figcaption>
            {current && (
              <img
                src={`data:${current.mimeType};base64,${current.data}`}
                alt={S.historyImage}
              />
            )}
            {checking && <p role="status">{S.historyImageChecking}</p>}
            {failed && <p role="alert">{S.historyImageUnavailable}</p>}
          </figure>
        )}
      </details>
    </div>
  );
}

/** Presentation of historical text only; its original message/copy is untouched. */
export function UserMessageContent({
  text,
  historical,
}: {
  text: string;
  historical: boolean;
}) {
  const parts = useMemo(
    () =>
      historical
        ? textImageParts(text)
        : [{ kind: "text" as const, text, offset: 0 }],
    [text, historical],
  );
  return (
    <div className="msg-user" data-loaded-body>
      {parts.map((part) =>
        part.kind === "text" ? (
          <span key={part.offset} data-find-block>
            {part.text}
          </span>
        ) : (
          <TextMessageImage key={part.offset} image={part} />
        ),
      )}
    </div>
  );
}
