import { useEffect, useRef, useState, type RefObject } from "react";
import { threads } from "../runtime/sessions";
import {
  attachmentSearchSourceCurrent,
  type AttachmentSearchLocation,
  type AttachmentPdfPreview,
} from "../runtime/attachment_search_source";
import {
  hasOpenSearchAncestors,
  revealSearchAncestors,
  searchDetailsCommitted,
} from "../runtime/transcript_search";
import { ATTACHMENT_SEARCH_STRINGS as S } from "../runtime/attachment_search_strings";
import "./LoadedSearchResults.css";
export type AttachmentSearchRequest = {
  source: AttachmentSearchLocation;
  token: object;
  pdfPreview?: AttachmentPdfPreview;
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
  const resumePosition = useRef<(() => void) | undefined>(undefined);
  const validNow = attachmentSearchSourceCurrent(
    request.source,
    threads.getSnapshot().threads,
    undefined,
    threads.getSnapshot().index,
  );
  useEffect(() => {
    if (!validNow) {
      setStatus("stale");
      return;
    }
    setStatus("locating");
    let disposed = false,
      release = () => {},
      highlighted: HTMLElement | undefined;
    let root: HTMLElement | null | undefined;
    let observer: MutationObserver | undefined;
    let schedule: (() => void) | undefined;
    let settled = false;
    const stopWaiting = () => {
      observer?.disconnect();
      if (schedule) root?.removeEventListener("toggle", schedule, true);
      if (resumePosition.current === schedule)
        resumePosition.current = undefined;
    };
    const stale = () => {
      settled = true;
      stopWaiting();
      release();
      release = () => {};
      highlighted?.classList.remove("search-match");
      setStatus("stale");
    };
    const valid = () =>
      !disposed &&
      live.current === request &&
      !!root?.isConnected &&
      host.current?.querySelector(".transcript") === root &&
      attachmentSearchSourceCurrent(
        request.source,
        threads.getSnapshot().threads,
        undefined,
        threads.getSnapshot().index,
      );
    let frame = requestAnimationFrame(() => {
      root = host.current?.querySelector<HTMLElement>(".transcript");
      if (!root || !valid()) {
        stale();
        return;
      }
      const find = () => {
        const messages = [
          ...root!.querySelectorAll<HTMLElement>("[data-loaded-message]"),
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
        stale();
        return;
      }
      release = revealSearchAncestors(source.attachment, root);
      let pending = false;
      const position = () => {
        pending = false;
        const refreshed = valid() ? find() : null;
        if (
          !root ||
          !refreshed ||
          !refreshed.attachment.isConnected ||
          !refreshed.message.isConnected
        ) {
          stale();
          return;
        }
        if (
          !hasOpenSearchAncestors(refreshed.attachment, root) ||
          !searchDetailsCommitted(root) ||
          !Array.from(refreshed.attachment.getClientRects()).some(
            (rect) => rect.width > 0 && rect.height > 0,
          )
        )
          return;
        highlighted = refreshed.message;
        highlighted.classList.add("search-match");
        highlighted.focus({ preventScroll: true });
        if (valid() && refreshed.attachment.isConnected) {
          refreshed.attachment.scrollIntoView({
            block: "center",
            behavior: "instant",
          });
          settled = true;
          stopWaiting();
          setStatus("located");
        } else stale();
      };
      schedule = () => {
        if (disposed || settled || pending) return;
        pending = true;
        frame = requestAnimationFrame(position);
      };
      observer = new MutationObserver(schedule);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["open", "hidden"],
      });
      root.addEventListener("toggle", schedule, true);
      resumePosition.current = schedule;
      schedule();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      stopWaiting();
      release();
      highlighted?.classList.remove("search-match");
    };
  }, [host, request, validNow]);
  useEffect(() => {
    resumePosition.current?.();
  }, [revision]);
  return (
    <div className="loaded-search-jump">
      <span role="status">{S[validNow ? status : "stale"]}</span>
      <button type="button" className="btn btn-text" onClick={onClose}>
        {S.close}
      </button>
    </div>
  );
}
