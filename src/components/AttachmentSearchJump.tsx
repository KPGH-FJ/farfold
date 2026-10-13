import { useEffect, useRef, useState, type RefObject } from "react";
import { threads } from "../runtime/sessions";
import {
  attachmentSearchSourceCurrent,
  type AttachmentSearchLocation,
} from "../runtime/attachment_search_source";
import { revealSearchAncestors } from "../runtime/transcript_search";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";
import "./LoadedSearchResults.css";
export type AttachmentSearchRequest = {
  source: AttachmentSearchLocation;
  token: object;
};
export function AttachmentSearchJump({
  host,
  request,
  revision,
  onClose,
}: {
  host: RefObject<HTMLElement | null>;
  request: AttachmentSearchRequest;
  revision: unknown;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<"locating" | "located" | "stale">(
    "locating",
  );
  const live = useRef(request);
  live.current = request;
  const validNow = attachmentSearchSourceCurrent(
    request.source,
    threads.getSnapshot().threads,
    undefined,
    threads.getSnapshot().index,
  );
  void revision;
  useEffect(() => {
    if (!validNow) {
      setStatus("stale");
      return;
    }
    setStatus("locating");
    let disposed = false,
      release = () => {},
      highlighted: HTMLElement | undefined;
    const valid = () =>
      !disposed &&
      live.current === request &&
      attachmentSearchSourceCurrent(
        request.source,
        threads.getSnapshot().threads,
        undefined,
        threads.getSnapshot().index,
      );
    let frame = requestAnimationFrame(() => {
      const root = host.current?.querySelector<HTMLElement>(".transcript");
      if (!root || !valid()) {
        setStatus("stale");
        return;
      }
      const find = () => {
        const messages = [
          ...root.querySelectorAll<HTMLElement>("[data-loaded-message]"),
        ].filter((n) => n.dataset.loadedMessage === request.source.itemId);
        const nodes =
          messages.length === 1
            ? [
                ...messages[0].querySelectorAll<HTMLElement>(
                  "[data-loaded-attachment]",
                ),
              ].filter(
                (n) =>
                  n.dataset.loadedAttachment ===
                  String(request.source.attachmentIndex),
              )
            : [];
        return nodes.length === 1
          ? { message: messages[0], attachment: nodes[0] }
          : null;
      };
      const source = find();
      if (!source) {
        setStatus("stale");
        return;
      }
      release = revealSearchAncestors(source.attachment, root);
      frame = requestAnimationFrame(() => {
        const refreshed =
          valid() &&
          root.isConnected &&
          host.current?.querySelector(".transcript") === root
            ? find()
            : null;
        if (
          !refreshed ||
          !refreshed.attachment.isConnected ||
          !refreshed.message.isConnected
        ) {
          release();
          release = () => {};
          setStatus("stale");
          return;
        }
        highlighted = refreshed.message;
        highlighted.classList.add("search-match");
        highlighted.focus({ preventScroll: true });
        if (valid() && refreshed.attachment.isConnected)
          refreshed.attachment.scrollIntoView({
            block: "center",
            behavior: "instant",
          });
        setStatus("located");
      });
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      release();
      highlighted?.classList.remove("search-match");
    };
  }, [host, request, validNow]);
  return (
    <div className="loaded-search-jump">
      <span role="status">{S[validNow ? status : "stale"]}</span>
      <button type="button" className="btn btn-text" onClick={onClose}>
        {S.close}
      </button>
    </div>
  );
}
