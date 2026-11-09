import { useLayoutEffect, useRef, useState } from "react";
import type { VisualPreview } from "../runtime/file_delivery";
import {
  IMAGE_INPUT_STRINGS,
  validateDraftImage,
} from "../runtime/draft_images";
import { renderPdfPage } from "../runtime/pdf_preview";
import { validPdfPage } from "../runtime/file_feedback_anchor";
import type { AttachmentPdfPreviewTarget } from "../runtime/attachment_search_source";
import { sameFileRevision } from "../runtime/file_revision_monitor";
import type { VisualPreviewReadiness } from "../runtime/visual_feedback";
import {
  checkedVisualPreview,
  checkedVisualPreviewMetadata,
  MAX_PDF_PAGES,
  VISUAL_PREVIEW_STRINGS as S,
} from "../runtime/visual_preview";
import {
  restoredPdfPage,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";
import {
  VisualAreaSelection,
  type VisualAreaDisplay,
  type VisualAreaCallbacks,
} from "./VisualAreaSelection";
import "./VisualFilePreview.css";

type PdfSurface = {
  slot: 0 | 1;
  canvas: { current: HTMLCanvasElement | null };
};
type DrawnPdfPage = {
  element: HTMLCanvasElement;
  page: number;
  pageCount: number;
};
export type DrawnPdfPreview = DrawnPdfPage & {
  preview: VisualPreview;
  surface: PdfSurface;
};
export type PdfPreviewCandidate = {
  preview: VisualPreview;
  surface: PdfSurface;
  page: number;
  controller: AbortController;
  current: () => boolean;
  settle: (result: DrawnPdfPage | Error) => void;
};

function pdfRenderWidth(container: HTMLDivElement | null) {
  // The selection stage has no intrinsic width while its canvas is hidden.
  const style = container ? getComputedStyle(container) : null;
  const width = container
    ? container.clientWidth -
      (Number.parseFloat(style?.paddingLeft ?? "0") || 0) -
      (Number.parseFloat(style?.paddingRight ?? "0") || 0)
    : 800;
  return Math.max(1, width) * Math.min(window.devicePixelRatio || 1, 2);
}

export function VisualFilePreview({
  preview,
  active,
  onReadiness,
  readingPosition,
  initialPdfPage,
  pdfCandidate,
  drawnPdf,
  interactionBlocked = false,
  onVisualTargetAvailability,
  onVisualTargetConfirm,
  onTargetEditing,
}: VisualAreaCallbacks & {
  preview: VisualPreview;
  active: boolean;
  interactionBlocked?: boolean;
  readingPosition?: PreviewReadingPositionRef;
  initialPdfPage?: AttachmentPdfPreviewTarget;
  pdfCandidate?: PdfPreviewCandidate;
  drawnPdf?: DrawnPdfPreview;
  onReadiness?: (value: VisualPreviewReadiness) => void;
}) {
  const initialCanvas = useRef<HTMLCanvasElement | null>(null);
  const canvas = drawnPdf?.surface.canvas ?? initialCanvas;
  const adoptedCanvas = useRef<HTMLCanvasElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const current = useRef<AbortController | null>(null);
  const imageElement = useRef<HTMLImageElement>(null);
  const [display, setDisplay] = useState<VisualAreaDisplay | null>(null);
  const displayOwner = useRef<VisualAreaDisplay | null>(null);
  const clearDisplay = () => {
    displayOwner.current = null;
    setDisplay(null);
  };
  const report = useRef(onReadiness);
  report.current = onReadiness;
  const source = useRef({ preview, active, interactionBlocked, drawnPdf });
  source.current = { preview, active, interactionBlocked, drawnPdf };
  const [requested, setRequested] = useState<{
    source: VisualPreview;
    page: number;
  } | null>(null);
  const initialPosition = () => {
    const target =
      preview.mimeType === "application/pdf" ? initialPdfPage : undefined;
    const valid =
      !target ||
      (sameFileRevision(target.file, preview.file) &&
        validPdfPage(target.pageNumber, MAX_PDF_PAGES));
    return {
      source: preview,
      page:
        target && valid
          ? target.pageNumber
          : restoredPdfPage(preview.file, readingPosition),
      target,
      valid,
    };
  };
  const initialPage = useRef(initialPosition());
  if (initialPage.current.source !== preview)
    initialPage.current = initialPosition();
  const searchTarget = initialPage.current.target;
  const searchCurrent =
    requested?.source === preview ||
    !searchTarget ||
    (initialPage.current.valid && searchTarget.current());
  const restorePage = requested?.source !== preview && !searchTarget;
  const page =
    requested?.source === preview ? requested.page : initialPage.current.page;
  const [displayedPage, setDisplayedPage] = useState(page);
  const [pages, setPages] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "paused">(
    "loading",
  );
  const [message, setMessage] = useState<string>(S.loading);
  const [image, setImage] = useState<{
    url: string;
    source: VisualPreview;
    owner: AbortController;
  } | null>(null);
  useLayoutEffect(() => {
    const operation = new AbortController();
    const element = canvas.current;
    current.current = operation;
    clearDisplay();
    report.current?.({ source: preview, location: null });
    setImage(null);
    setPages(null);
    if (!searchCurrent) {
      setState("failed");
      setMessage(S.changed);
      return () => operation.abort();
    }
    if (!active) {
      setState("paused");
      setMessage(S.paused);
      return () => operation.abort();
    }
    setState("loading");
    setMessage(S.loading);
    const owns = () =>
      current.current === operation &&
      !operation.signal.aborted &&
      source.current.preview === preview &&
      source.current.active &&
      (!searchTarget ||
        requested?.source === preview ||
        searchTarget.current());
    let renderedPages: number | null = null;
    let renderedPage = page;
    void (async () => {
      const pdf = preview.mimeType === "application/pdf";
      if (!pdf) {
        checkedVisualPreviewMetadata(preview.file, preview);
        const result = await validateDraftImage(
          preview.data,
          preview.mimeType ?? "",
          preview.file.size,
        );
        if (owns())
          setImage({
            url: `data:${result.mimeType};base64,${result.data}`,
            source: preview,
            owner: operation,
          });
      } else {
        checkedVisualPreviewMetadata(preview.file, preview);
        if (!owns() || !element) return;
        const ready = (total: number, actual = page) => {
          if (owns() && validPdfPage(actual, total)) {
            renderedPage = actual;
            renderedPages = total;
            setPages(total);
          }
        };
        if (
          drawnPdf?.preview === preview &&
          drawnPdf.element === element &&
          adoptedCanvas.current !== element &&
          element.width > 0 &&
          element.height > 0
        ) {
          adoptedCanvas.current = element;
          ready(drawnPdf.pageCount, drawnPdf.page);
        } else {
          await renderPdfPage(
            () => checkedVisualPreview(preview.file, preview).bytes,
            element,
            page,
            pdfRenderWidth(viewport.current),
            operation.signal,
            ready,
            restorePage,
          );
        }
      }
      if (owns()) {
        if (pdf && renderedPages === null) throw new Error(S.failed);
        setState("ready");
        setMessage(S.snapshot);
        if (pdf) {
          if (element && element.width > 0 && element.height > 0) {
            const next: VisualAreaDisplay = {
              kind: "pdf",
              preview,
              owner: operation,
              element,
              pixelWidth: element.width,
              pixelHeight: element.height,
              page: renderedPage,
              pageCount: renderedPages!,
            };
            displayOwner.current = next;
            setDisplay(next);
          }
          setDisplayedPage(renderedPage);
          // The strict intent ends only after a verified draw. Later ordinary
          // reading is independent of closing or replacing the search result.
          if (searchTarget && requested?.source !== preview)
            setRequested({ source: preview, page: renderedPage });
          saveReadingPosition(readingPosition, preview.file, {
            kind: "pdf",
            page: renderedPage,
          });
          report.current?.({
            source: preview,
            location: {
              kind: "pdf",
              page: renderedPage,
              pageCount: renderedPages!,
            },
          });
        }
      }
    })().catch((error) => {
      if (!owns()) return;
      clearDisplay();
      setImage(null);
      report.current?.({ source: preview, location: null });
      setState("failed");
      setMessage(
        error instanceof Error &&
          error.message === IMAGE_INPUT_STRINGS.decodeBusy
          ? S.busy
          : error instanceof Error &&
              Object.values(S).includes(error.message as never)
            ? error.message
            : S.failed,
      );
    });
    return () => {
      clearDisplay();
      operation.abort();
      if (element) {
        element.width = 0;
        element.height = 0;
      }
      if (current.current === operation) {
        current.current = null;
        report.current?.({ source: preview, location: null });
      }
    };
  }, [
    preview,
    active,
    page,
    restorePage,
    readingPosition,
    searchCurrent,
    drawnPdf,
  ]);
  useLayoutEffect(() => {
    if (!pdfCandidate) return;
    const {
      preview: next,
      surface,
      page,
      controller,
      current,
      settle,
    } = pdfCandidate;
    const element = surface.canvas.current;
    if (!active || !current()) {
      controller.abort();
      return;
    }
    if (!element) {
      settle(new Error(S.failed));
      return;
    }
    element.width = 0;
    element.height = 0;
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") controller.abort();
    };
    if (typeof document !== "undefined") {
      stopWhenHidden();
      document.addEventListener("visibilitychange", stopWhenHidden);
    }
    void (async () => {
      checkedVisualPreviewMetadata(next.file, next);
      let location: { page: number; pageCount: number } | undefined;
      await renderPdfPage(
        () => checkedVisualPreview(next.file, next).bytes,
        element,
        page,
        pdfRenderWidth(viewport.current),
        controller.signal,
        (pageCount, actual = page) => {
          if (validPdfPage(actual, pageCount))
            location = { page: actual, pageCount };
        },
        true,
      );
      if (!current() || controller.signal.aborted) throw new Error(S.cancelled);
      if (!location || !element.width || !element.height)
        throw new Error(S.failed);
      settle({ element, ...location });
    })().catch((error: unknown) =>
      settle(error instanceof Error ? error : new Error(S.failed)),
    );
    return () => {
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", stopWhenHidden);
      controller.abort();
      // The winning surface is reused by the displayed page's own effect.
      const displayed = source.current;
      if (
        !displayed.active ||
        displayed.preview !== next ||
        displayed.drawnPdf?.surface !== surface ||
        displayed.drawnPdf.element !== element ||
        surface.canvas.current !== element
      ) {
        element.width = 0;
        element.height = 0;
      }
    };
  }, [active, pdfCandidate]);
  const pdf = preview.mimeType === "application/pdf";
  const actionOwner = current.current;
  const displayedOperation = image?.owner ?? null;
  const ownsImage = () =>
    active &&
    source.current.active &&
    source.current.preview === preview &&
    image?.source === preview &&
    displayedOperation !== null &&
    current.current === displayedOperation &&
    !displayedOperation.signal.aborted;
  const pixels = (
    <>
      {" "}
      {pdf && [
        <canvas
          key={drawnPdf?.surface.slot ?? 0}
          ref={canvas}
          hidden={state !== "ready" || !active}
          aria-label={
            pages === null ? "PDF 预览" : S.page(displayedPage, pages)
          }
        />,
        pdfCandidate && (
          <canvas
            key={pdfCandidate.surface.slot}
            ref={pdfCandidate.surface.canvas}
            hidden
          />
        ),
      ]}
      {image && image.source === preview && state === "ready" && active && (
        <img
          ref={imageElement}
          src={image.url}
          alt={preview.file.name}
          onLoad={() => {
            if (ownsImage()) {
              const element = imageElement.current;
              if (
                element &&
                element.naturalWidth > 0 &&
                element.naturalHeight > 0
              ) {
                const next: VisualAreaDisplay = {
                  kind: "image",
                  preview,
                  owner: displayedOperation!,
                  element,
                  pixelWidth: element.naturalWidth,
                  pixelHeight: element.naturalHeight,
                };
                displayOwner.current = next;
                setDisplay(next);
              }
              report.current?.({
                source: preview,
                location: { kind: "image" },
              });
            }
          }}
          onError={() => {
            if (ownsImage()) {
              clearDisplay();
              displayedOperation?.abort();
              setImage(null);
              setState("failed");
              setMessage(S.failed);
              report.current?.({ source: preview, location: null });
            }
          }}
        />
      )}
    </>
  );
  return (
    <div
      ref={viewport}
      className="visual-file-preview"
      aria-busy={state === "loading"}
      inert={interactionBlocked}
    >
      <div className="visual-file-controls">
        {pdf && pages !== null && state === "ready" && (
          <>
            <button
              type="button"
              className="btn btn-text"
              disabled={!active || interactionBlocked || displayedPage <= 1}
              onClick={() => {
                if (
                  !source.current.active ||
                  source.current.preview !== preview ||
                  source.current.interactionBlocked ||
                  current.current !== actionOwner ||
                  current.current?.signal.aborted
                )
                  return;
                clearDisplay();
                current.current?.abort();
                report.current?.({ source: preview, location: null });
                setRequested({ source: preview, page: displayedPage - 1 });
              }}
            >
              {S.previous}
            </button>
            <span>{S.page(displayedPage, pages)}</span>
            <button
              type="button"
              className="btn btn-text"
              disabled={!active || interactionBlocked || displayedPage >= pages}
              onClick={() => {
                if (
                  !source.current.active ||
                  source.current.preview !== preview ||
                  source.current.interactionBlocked ||
                  current.current !== actionOwner ||
                  current.current?.signal.aborted
                )
                  return;
                clearDisplay();
                current.current?.abort();
                report.current?.({ source: preview, location: null });
                setRequested({ source: preview, page: displayedPage + 1 });
              }}
            >
              {S.next}
            </button>
          </>
        )}
        {state === "loading" && (
          <button
            type="button"
            className="btn btn-text"
            onClick={() => {
              if (
                !source.current.active ||
                source.current.preview !== preview ||
                source.current.interactionBlocked ||
                current.current !== actionOwner
              )
                return;
              clearDisplay();
              current.current?.abort();
              report.current?.({ source: preview, location: null });
              setState("paused");
              setMessage(S.cancelled);
            }}
          >
            {S.cancel}
          </button>
        )}
      </div>
      <p role={state === "failed" ? "alert" : "status"}>{message}</p>
      {onVisualTargetConfirm ? (
        <VisualAreaSelection
          preview={preview}
          display={active ? display : null}
          interactionBlocked={interactionBlocked}
          isCurrent={(expected) =>
            displayOwner.current === expected &&
            expected.preview === preview &&
            source.current.preview === preview &&
            source.current.active &&
            current.current === expected.owner &&
            !current.current?.signal.aborted &&
            (expected.kind === "pdf"
              ? canvas.current === expected.element &&
                canvas.current.width === expected.pixelWidth &&
                canvas.current.height === expected.pixelHeight
              : imageElement.current === expected.element &&
                imageElement.current.naturalWidth === expected.pixelWidth &&
                imageElement.current.naturalHeight === expected.pixelHeight &&
                imageElement.current.getAttribute("src") === image?.url)
          }
          onVisualTargetAvailability={onVisualTargetAvailability}
          onVisualTargetConfirm={onVisualTargetConfirm}
          onTargetEditing={onTargetEditing}
        >
          {pixels}
        </VisualAreaSelection>
      ) : (
        pixels
      )}
    </div>
  );
}
