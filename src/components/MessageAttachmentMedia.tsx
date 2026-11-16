import { useCallback, useLayoutEffect, useRef } from "react";
import type { attachmentMedia } from "../runtime/message_attachments";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";

type Media = NonNullable<ReturnType<typeof attachmentMedia>>;

/** The owner grants this mounted preview a lease. It owns failure feedback and
 * explicit retries, so a failed element must retire before returning its lease. */
export function MessageAttachmentMedia({
  media,
  name,
  onFailure,
  onFocusedFailure,
}: {
  media: Media;
  name: string;
  onFailure(): void;
  onFocusedFailure?(element: HTMLElement): void;
}) {
  const node = useRef<HTMLImageElement | HTMLAudioElement | null>(null);
  const owner = useRef({ live: false, failed: false });
  useLayoutEffect(() => {
    const current = owner.current;
    current.live = true;
    return () => {
      current.live = false;
    };
  }, []);
  const retire = (element: HTMLImageElement | HTMLAudioElement) => {
    if (element.getAttribute("src") === null) return;
    if (element.tagName === "AUDIO") {
      const audio = element as HTMLAudioElement;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } else element.removeAttribute("src");
  };
  const mediaRef = useCallback(
    (next: HTMLImageElement | HTMLAudioElement | null) => {
      const previous = node.current;
      node.current = owner.current.failed ? null : next;
      // A ref replay may restore a live admitted source, never a failed one.
      if (
        next &&
        !owner.current.failed &&
        next.getAttribute("src") !== media.src
      )
        next.setAttribute("src", media.src);
      if (previous && previous !== next) retire(previous);
    },
    [media.src],
  );
  const onError = (event: {
    currentTarget: HTMLImageElement | HTMLAudioElement;
  }) => {
    const current = owner.current;
    const element = event.currentTarget;
    if (
      !current.live ||
      current.failed ||
      node.current !== element ||
      !element.isConnected
    )
      return;
    // pause/load can synchronously dispatch more events. Invalidate this owner
    // first, clear only its source, then let the parent release its exact lease.
    current.failed = true;
    node.current = null;
    if (
      onFocusedFailure &&
      element.tagName === "AUDIO" &&
      element.ownerDocument.activeElement === element
    )
      onFocusedFailure(element);
    retire(element);
    onFailure();
  };
  return (
    <div className="message-attachment-media">
      {media.kind === "image" ? (
        <img ref={mediaRef} src={media.src} alt={name} onError={onError} />
      ) : (
        <audio
          ref={mediaRef}
          controls
          preload="none"
          src={media.src}
          aria-label={name}
          onError={onError}
        >
          {S.audioUnavailable}
        </audio>
      )}
    </div>
  );
}
