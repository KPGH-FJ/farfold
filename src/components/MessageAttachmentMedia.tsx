import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import type { attachmentMedia } from "../runtime/message_attachments";
import { MESSAGE_ATTACHMENTS as S } from "../runtime/message_attachment_strings";

type Media = NonNullable<ReturnType<typeof attachmentMedia>>;

/** The parent admits only attachmentMedia's embedded inert data, on the user's
 * explicit expansion. Its src key retires this state when the resource changes. */
export function MessageAttachmentMedia({
  media,
  name,
}: {
  media: Media;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const statusId = useId();
  const wrapper = useRef<HTMLDivElement | null>(null);
  const node = useRef<HTMLImageElement | HTMLAudioElement | null>(null);
  const owner = useRef({ live: false, attempt: 0, failed: false });
  useLayoutEffect(() => {
    const current = owner.current;
    current.live = true;
    return () => {
      current.live = false;
    };
  }, []);
  const mediaRef = useCallback(
    (next: HTMLImageElement | HTMLAudioElement | null) => {
      const previous = node.current;
      node.current = next;
      // React may detach and reattach the same element without writing props
      // again (including StrictMode ref replay). Restore only this exact already
      // admitted source if our own detach cleared it; never use an external URI.
      if (next?.tagName === "AUDIO" && next.getAttribute("src") !== media.src)
        next.setAttribute("src", media.src);
      if (previous && previous !== next && previous.tagName === "AUDIO") {
        // A detached player must not keep playing. This releases this element;
        // it is not a claim that all browser decoding has synchronously stopped.
        const audio = previous as HTMLAudioElement;
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    },
    [media.src],
  );
  const current = (element: HTMLElement) =>
    owner.current.live &&
    owner.current.attempt === attempt &&
    node.current === element &&
    element.isConnected;
  const onError = (event: { currentTarget: HTMLElement }) => {
    if (!current(event.currentTarget)) return;
    owner.current.failed = true;
    setFailed(true);
  };
  return (
    <div className="message-attachment-media" ref={wrapper} tabIndex={-1}>
      {media.kind === "image" ? (
        <img
          key={attempt}
          ref={mediaRef}
          src={media.src}
          alt={name}
          onError={onError}
          aria-describedby={failed ? statusId : undefined}
        />
      ) : (
        <audio
          key={attempt}
          ref={mediaRef}
          controls
          preload="none"
          src={media.src}
          aria-label={name}
          onError={onError}
          aria-describedby={failed ? statusId : undefined}
        >
          {S.audioUnavailable}
        </audio>
      )}
      {failed && (
        <div className="message-attachment-media-failure">
          <p id={statusId} role="status">
            {media.kind === "image" ? S.imageFailed : S.audioFailed}
          </p>
          <button
            type="button"
            onClick={(event) => {
              const state = owner.current;
              if (
                !state.live ||
                !state.failed ||
                !event.currentTarget.isConnected
              )
                return;
              state.failed = false;
              state.attempt++;
              // Preserve keyboard focus before removing the retry button. Do not
              // pull focus back if the user has already moved elsewhere.
              if (
                document.activeElement === event.currentTarget &&
                wrapper.current?.isConnected
              )
                wrapper.current.focus();
              setFailed(false);
              setAttempt(state.attempt);
            }}
          >
            {S.retryMedia}
          </button>
        </div>
      )}
    </div>
  );
}
