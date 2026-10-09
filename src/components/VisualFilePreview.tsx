import { useLayoutEffect, useRef, useState } from "react";
import type { VisualPreview } from "../runtime/file_delivery";
import { validateDraftImage } from "../runtime/draft_images";
import { renderPdfPage } from "../runtime/pdf_preview";
import { validPdfPage } from "../runtime/file_feedback_anchor";
import type { VisualPreviewReadiness } from "../runtime/visual_feedback";
import {
  checkedVisualPreview,
  VISUAL_PREVIEW_STRINGS as S,
} from "../runtime/visual_preview";
import {
  restoredPdfPage,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";
import "./VisualFilePreview.css";

export function VisualFilePreview({
  preview,
  active,
  onReadiness,
  readingPosition,
}: {
  preview: VisualPreview;
  active: boolean;
  readingPosition?: PreviewReadingPositionRef;
  onReadiness?: (value: VisualPreviewReadiness) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const current = useRef<AbortController | null>(null);
  const report = useRef(onReadiness);
  report.current = onReadiness;
  const source = useRef({ preview, active });
  source.current = { preview, active };
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
      const checked = checkedVisualPreview(preview.file, preview);
      if (checked.kind === "image") {
        const result = await validateDraftImage(preview.data, checked.mimeType);
        if (owns())
          setImage({
            url: `data:${result.mimeType};base64,${result.data}`,
            source: preview,
            owner: operation,
          });
      } else {
        if (!owns() || !canvas.current) return;
        await renderPdfPage(
          checked.bytes,
          canvas.current,
          page,
          Math.max(1, canvas.current.parentElement?.clientWidth ?? 800) *
            Math.min(window.devicePixelRatio || 1, 2),
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
        if (checked.kind === "pdf" && renderedPages === null)
          throw new Error(S.failed);
        setState("ready");
        setMessage(S.snapshot);
        if (checked.kind === "pdf") {
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
      setImage(null);
      report.current?.({ source: preview, location: null });
      setState("failed");
      setMessage(
        error instanceof Error &&
          Object.values(S).includes(error.message as never)
          ? error.message
          : S.failed,
      );
    });
    return () => {
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
  const displayedOperation = image?.owner ?? null;
  const ownsImage = () =>
    active &&
    source.current.active &&
    source.current.preview === preview &&
    image?.source === preview &&
    displayedOperation !== null &&
    current.current === displayedOperation &&
    !displayedOperation.signal.aborted;
  return (
    <div className="visual-file-preview" aria-busy={state === "loading"}>
      <div className="visual-file-controls">
        {pdf && pages !== null && state === "ready" && (
          <>
            <button
              type="button"
              className="btn btn-text"
              disabled={!active || displayedPage <= 1}
              onClick={() =>
                setRequested({ source: preview, page: displayedPage - 1 })
              }
            >
              {S.previous}
            </button>
            <span>{S.page(displayedPage, pages)}</span>
            <button
              type="button"
              className="btn btn-text"
              disabled={!active || displayedPage >= pages}
              onClick={() =>
                setRequested({ source: preview, page: displayedPage + 1 })
              }
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
          src={image.url}
          alt={preview.file.name}
          onLoad={() => {
            if (ownsImage())
              report.current?.({
                source: preview,
                location: { kind: "image" },
              });
          }}
          onError={() => {
            if (ownsImage()) {
              displayedOperation?.abort();
              setImage(null);
              setState("failed");
              setMessage(S.failed);
              report.current?.({ source: preview, location: null });
            }
          }}
        />
      )}
    </div>
  );
}
