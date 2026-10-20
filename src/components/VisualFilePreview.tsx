import { useLayoutEffect, useRef, useState } from "react";
import type { VisualPreview } from "../runtime/file_delivery";
import {
  IMAGE_INPUT_STRINGS,
  validateDraftImage,
} from "../runtime/draft_images";
import { renderPdfPage } from "../runtime/pdf_preview";
import { validPdfPage } from "../runtime/file_feedback_anchor";
import type { VisualPreviewReadiness } from "../runtime/visual_feedback";
import {
  checkedVisualPreview,
  checkedVisualPreviewMetadata,
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

export function VisualFilePreview({
  preview,
  active,
  onReadiness,
  readingPosition,
  interactionBlocked = false,
  onVisualTargetAvailability,
  onVisualTargetConfirm,
  onTargetEditing,
}: VisualAreaCallbacks & {
  preview: VisualPreview;
  active: boolean;
  interactionBlocked?: boolean;
  readingPosition?: PreviewReadingPositionRef;
  onReadiness?: (value: VisualPreviewReadiness) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
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
  const source = useRef({ preview, active, interactionBlocked });
  source.current = { preview, active, interactionBlocked };
  const [requested, setRequested] = useState<{
    source: VisualPreview;
    page: number;
  } | null>(null);
  const initialPage = useRef({
    source: preview,
    page: restoredPdfPage(preview.file, readingPosition),
  });
  if (initialPage.current.source !== preview)
    initialPage.current = {
      source: preview,
      page: restoredPdfPage(preview.file, readingPosition),
    };
  const restorePage = requested?.source !== preview;
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
    current.current = operation;
    clearDisplay();
    report.current?.({ source: preview, location: null });
    setImage(null);
    setPages(null);
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
      source.current.active;
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
        if (!owns() || !canvas.current) return;
        // The optional selection stage is fit-content and has no intrinsic
        // width while its canvas is hidden. Measure the stable content pane.
        const container = viewport.current;
        const style = container ? getComputedStyle(container) : null;
        const width = container
          ? container.clientWidth -
            (Number.parseFloat(style?.paddingLeft ?? "0") || 0) -
            (Number.parseFloat(style?.paddingRight ?? "0") || 0)
          : 800;
        await renderPdfPage(
          () => checkedVisualPreview(preview.file, preview).bytes,
          canvas.current,
          page,
          Math.max(1, width) * Math.min(window.devicePixelRatio || 1, 2),
          operation.signal,
          (total, actual = page) => {
            if (owns() && validPdfPage(actual, total)) {
              renderedPage = actual;
              renderedPages = total;
              setPages(total);
            }
          },
          restorePage,
        );
      }
      if (owns()) {
        if (pdf && renderedPages === null) throw new Error(S.failed);
        setState("ready");
        setMessage(S.snapshot);
        if (pdf) {
          const element = canvas.current;
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
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      if (current.current === operation) {
        current.current = null;
        report.current?.({ source: preview, location: null });
      }
    };
  }, [preview, active, page, restorePage, readingPosition]);
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
      {pdf && (
        <canvas
          ref={canvas}
          hidden={state !== "ready" || !active}
          aria-label={
            pages === null ? "PDF 预览" : S.page(displayedPage, pages)
          }
        />
      )}
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
