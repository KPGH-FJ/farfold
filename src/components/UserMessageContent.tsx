import { useLayoutEffect, useMemo, useState } from "react";
import { CaretDown, Paperclip } from "@phosphor-icons/react";
import {
  textImageParts,
  type TextImagePart,
} from "../runtime/text_image_links";
import { validateDraftImage, type DraftImage } from "../runtime/draft_images";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";
import { MAX_IMAGE_BYTES } from "../runtime/image_bytes";
import {
  attachmentMediaPreviewEligibility,
  type MessageMediaPreviewEligibility,
} from "../runtime/message_attachments";
import {
  messageMediaBudget,
  type MessageMediaLease,
} from "../runtime/message_media_budget";
import { MessageAttachmentMedia } from "./MessageAttachmentMedia";
import { useMessageMediaVisibility } from "./message-media-visibility";
import "../message-attachments.css";

type TextImage = Extract<TextImagePart, { kind: "image" }>;
type HistoryPreview = {
  eligibility: MessageMediaPreviewEligibility;
  attempt: number;
  checked: DraftImage | null;
  lease: MessageMediaLease | null;
  checking: boolean;
  failed: boolean;
  budgetRejected: boolean;
};

/** Reserve shared file bytes before the existing draft-image validator. Its
 * 8 MiB/static/dimension checks and two real decoder slots remain unchanged. */
function useHistoryImagePreview(image: TextImage, enabled: boolean) {
  const eligibility = useMemo(
    () =>
      enabled
        ? attachmentMediaPreviewEligibility({
            name: S.historyImage,
            data: image.data,
            mimeType: image.mimeType,
          })
        : null,
    [enabled, image.data, image.mimeType],
  );
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<HistoryPreview | null>(null);
  useLayoutEffect(() => {
    if (!eligibility) {
      setResult(null);
      return;
    }
    const base: HistoryPreview = {
      eligibility,
      attempt,
      checked: null,
      lease: null,
      checking: false,
      failed: false,
      budgetRejected: false,
    };
    if (
      eligibility.status !== "eligible" ||
      eligibility.bytes > MAX_IMAGE_BYTES
    ) {
      setResult({ ...base, failed: true });
      return;
    }
    const lease = messageMediaBudget.acquire(eligibility.bytes);
    if (!lease) {
      setResult({ ...base, budgetRejected: true });
      return;
    }
    let live = true;
    setResult({ ...base, lease, checking: true });
    const settle = (checked: DraftImage | null) => {
      if (!checked) lease.release();
      if (live)
        setResult({
          ...base,
          checked,
          lease: checked ? lease : null,
          failed: !checked,
        });
    };
    void validateDraftImage(image.data, image.mimeType).then(
      (checked) => settle(checked),
      () => settle(null),
    );
    return () => {
      live = false;
      lease.release();
    };
  }, [eligibility, attempt, image.data, image.mimeType]);
  const current =
    !!eligibility &&
    result?.eligibility === eligibility &&
    result.attempt === attempt;
  return {
    checked: current && result.lease ? result.checked : null,
    checking: !!eligibility && (!current || result.checking),
    failed: current && result.failed,
    budgetRejected: current && result.budgetRejected,
    fail: () => {
      if (!current || !result.lease || result.failed) return;
      result.lease.release();
      setResult((previous) =>
        previous === result
          ? { ...previous, checked: null, lease: null, failed: true }
          : previous,
      );
    },
    retry: () => setAttempt((value) => value + 1),
  };
}

/** Hidden ancestry withdraws both the source and this owner's expansion intent.
 * A late validation may settle its real decoder, but cannot restore this view. */
export function TextMessageImage({ image }: { image: TextImage }) {
  const visible = useMessageMediaVisibility();
  const [opened, setOpened] = useState<TextImage | null>(null);
  const expanded =
    visible &&
    opened?.data === image.data &&
    opened.mimeType === image.mimeType;
  useLayoutEffect(() => {
    setOpened(null);
  }, [image.data, image.mimeType, visible]);
  const { checked, checking, failed, budgetRejected, fail, retry } =
    useHistoryImagePreview(image, expanded);
  const toggle = (open: boolean) => {
    if (visible) setOpened(open ? image : null);
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
            {checked && (
              <MessageAttachmentMedia
                key={`${checked.mimeType}:${checked.data}`}
                media={{
                  kind: "image",
                  src: `data:${checked.mimeType};base64,${checked.data}`,
                }}
                name={S.historyImage}
                onFailure={fail}
              />
            )}
            {checking && <p role="status">{S.historyImageChecking}</p>}
            {(failed || budgetRejected) && (
              <div className="message-attachment-media-failure">
                <p role="alert">
                  {budgetRejected
                    ? S.mediaBudgetReached
                    : S.historyImageUnavailable}
                </p>
                <button
                  type="button"
                  onClick={(event) => {
                    if (!event.currentTarget.isConnected) return;
                    if (document.activeElement === event.currentTarget)
                      event.currentTarget
                        .closest("details")
                        ?.querySelector("summary")
                        ?.focus();
                    retry();
                  }}
                >
                  {S.retryMedia}
                </button>
              </div>
            )}
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
