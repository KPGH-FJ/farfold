import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { PptxPreview, PptxShape } from "../runtime/pptx_types";
import { PPTX_STRINGS as S, PPTX_WARNINGS } from "../runtime/pptx_strings";
import {
  createPptxFeedbackSource,
  pptxFeedbackTarget,
  retirePptxFeedbackSource,
  type PptxFeedbackSource,
} from "../runtime/pptx_feedback_target";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import {
  restoredPptxSlide,
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";

/** Passive paint objects and literal text. Shapes retain their source paint
 * order; each shape's geometry and text remain together in that same layer. */
function Shape({
  shape,
  url,
  onError,
}: {
  shape: PptxShape;
  url?: string;
  onError: () => void;
}) {
  const { box, groupTransform: group } = shape;
  if (!box.width || !box.height) return null;
  const position: CSSProperties = {
    left: group ? group.x + box.x * group.scaleX : box.x,
    top: group ? group.y + box.y * group.scaleY : box.y,
    width: box.width,
    height: box.height,
    ...(group
      ? {
          transform: `scale(${group.scaleX}, ${group.scaleY})`,
          transformOrigin: "top left",
        }
      : {}),
  };
  if (shape.kind === "image")
    return url ? (
      <img
        className="pptx-image"
        style={position}
        src={url}
        alt={S.image}
        draggable={false}
        onError={onError}
      />
    ) : null;
  const body = shape.text;
  return (
    <div className="pptx-shape" style={position}>
      {shape.geometry && (
        <svg
          className="pptx-geometry"
          width={box.width}
          height={box.height}
          viewBox={`0 0 ${box.width} ${box.height}`}
          aria-hidden="true"
        >
          {shape.geometry === "rect" ? (
            <rect
              x={0}
              y={0}
              width={box.width}
              height={box.height}
              fill={shape.fill ?? "none"}
              stroke={shape.stroke?.color ?? "none"}
              strokeWidth={shape.stroke?.width ?? 0}
            />
          ) : (
            <ellipse
              cx={box.width / 2}
              cy={box.height / 2}
              rx={box.width / 2}
              ry={box.height / 2}
              fill={shape.fill ?? "none"}
              stroke={shape.stroke?.color ?? "none"}
              strokeWidth={shape.stroke?.width ?? 0}
            />
          )}
        </svg>
      )}
      {body && (
        <div
          className="pptx-text"
          style={{
            padding: `${body.inset.top}px ${body.inset.right}px ${body.inset.bottom}px ${body.inset.left}px`,
            justifyContent:
              body.verticalAlign === "top"
                ? "flex-start"
                : body.verticalAlign === "center"
                  ? "center"
                  : "flex-end",
            whiteSpace: body.wrap === "none" ? "pre" : "pre-wrap",
            overflowWrap: body.wrap === "none" ? "normal" : "anywhere",
          }}
        >
          {body.paragraphs.map((paragraph, index) => (
            <p key={index} style={{ textAlign: paragraph.alignment }}>
              {paragraph.runs.map((run, at) =>
                run.kind === "break" ? (
                  <br key={at} />
                ) : (
                  <span
                    key={at}
                    style={{
                      fontFamily: `"${run.fontFamily}", sans-serif`,
                      fontSize: run.fontSize,
                      color: run.color,
                      fontWeight: run.bold ? 700 : 400,
                      fontStyle: run.italic ? "italic" : "normal",
                      textDecoration: run.underline ? "underline" : "none",
                    }}
                  >
                    {run.text}
                  </span>
                ),
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function PptxSlideView({
  preview,
  readingPosition,
  interactionBlocked,
  isCurrent,
  onImageFailure,
  onOfficeTargetAvailability,
  onOfficeTargetConfirm,
}: {
  preview: PptxPreview;
  readingPosition?: PreviewReadingPositionRef;
  interactionBlocked: boolean;
  isCurrent: () => boolean;
  onImageFailure: () => void;
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm?: (value: OfficeTargetConfirmation) => void;
}) {
  const [selection, setSelection] = useState<{
    preview: PptxPreview;
    index: number;
    token: object;
  } | null>(null);
  const initial = useRef({ preview, token: {} });
  if (initial.current.preview !== preview)
    initial.current = { preview, token: {} };
  const selectionToken =
    selection?.preview === preview ? selection.token : initial.current.token;
  const index =
    selection?.preview === preview
      ? selection.index
      : restoredPptxSlide(preview, readingPosition);
  const slide = preview.slides[index];
  const latest = useRef({
    preview,
    index,
    selectionToken,
    interactionBlocked,
    isCurrent,
    onImageFailure,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
  });
  latest.current = {
    preview,
    index,
    selectionToken,
    interactionBlocked,
    isCurrent,
    onImageFailure,
    onOfficeTargetAvailability,
    onOfficeTargetConfirm,
  };
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [resources, setResources] = useState<{
    slide: typeof slide;
    urls: Map<string, string>;
    token: object;
  } | null>(null);
  const lease = useRef<object | null>(null);
  const mounted = useRef(false);
  const liveFeedback = useRef<{
    source: PptxFeedbackSource;
    selection: object;
    resource: object;
  } | null>(null);
  const [feedback, setFeedback] = useState<PptxFeedbackSource | null>(null);
  const feedbackButton = useRef<HTMLButtonElement>(null);
  const integrated = Boolean(onOfficeTargetConfirm);
  const feedbackEpoch = useRef({
    blocked: interactionBlocked,
    integrated,
    token: {},
  });
  if (
    feedbackEpoch.current.blocked !== interactionBlocked ||
    feedbackEpoch.current.integrated !== integrated
  ) {
    // Current interaction changes revoke the claim before queued layout cleanup.
    // Cleanup still reports withdrawal of this exact source to the parent.
    if (liveFeedback.current)
      retirePptxFeedbackSource(liveFeedback.current.source);
    feedbackEpoch.current = {
      blocked: interactionBlocked,
      integrated,
      token: {},
    };
  }
  const feedbackToken = feedbackEpoch.current.token;
  const retireFeedback = () => {
    const old = liveFeedback.current;
    liveFeedback.current = null;
    if (old) {
      retirePptxFeedbackSource(old.source);
      latest.current.onOfficeTargetAvailability?.({
        source: old.source,
        available: false,
      });
    }
  };
  const current = () =>
    mounted.current &&
    latest.current.preview === preview &&
    latest.current.index === index &&
    latest.current.selectionToken === selectionToken &&
    latest.current.isCurrent();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      lease.current = null;
      retireFeedback();
    };
  }, []);
  const feedbackCurrent = () =>
    feedbackEpoch.current.token === feedbackToken &&
    current() &&
    !latest.current.interactionBlocked &&
    Boolean(latest.current.onOfficeTargetConfirm) &&
    resources?.slide === slide &&
    lease.current !== null &&
    lease.current === resources?.token;
  useLayoutEffect(() => {
    if (interactionBlocked || !integrated) retireFeedback();
    return () => retireFeedback();
  }, [preview, slide, selectionToken, interactionBlocked, integrated]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setAvailableWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const token = {};
    lease.current = token;
    const urls = new Map<string, string>();
    try {
      const required = new Set(
        slide.shapes.flatMap((shape) =>
          shape.kind === "image" ? [shape.imageId] : [],
        ),
      );
      for (const image of preview.images)
        if (required.has(image.id))
          urls.set(
            image.id,
            URL.createObjectURL(
              new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
            ),
          );
      setResources({ slide, urls, token });
    } catch {
      if (current()) latest.current.onImageFailure();
    }
    return () => {
      if (lease.current === token) lease.current = null;
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [preview, slide, selectionToken]);
  useLayoutEffect(() => {
    if (current())
      saveReadingPosition(readingPosition, preview.file, {
        kind: "presentation",
        slide: { part: slide.part, index },
      });
  }, [preview, slide, index, readingPosition]);
  const select = (next: number) => {
    if (
      !current() ||
      latest.current.interactionBlocked ||
      !Number.isSafeInteger(next) ||
      next === index ||
      next < 0 ||
      next >= preview.slides.length
    )
      return;
    retireFeedback();
    if (!current() || latest.current.interactionBlocked) return;
    latest.current.index = next;
    const token = {};
    latest.current.selectionToken = token;
    setSelection({ preview, index: next, token });
    saveReadingPosition(readingPosition, preview.file, {
      kind: "presentation",
      slide: { part: preview.slides[next].part, index: next },
    });
  };
  const scale =
    availableWidth > 0 ? Math.min(1, availableWidth / preview.width) : 1;
  const warnings = preview.warnings.filter(
    (warning) => !warning.slideId || warning.slideId === slide.id,
  );
  return (
    <div className="pptx-deck">
      <p className="pptx-scope">
        {S.snapshot} {S.scope}
      </p>
      {preview.partial && (
        <p className="pptx-notice" role="status">
          {S.partial}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="pptx-warnings">
          {warnings.map((warning) => (
            <li key={`${warning.code}:${warning.slideId ?? ""}`}>
              {PPTX_WARNINGS[warning.code]} ({warning.count})
            </li>
          ))}
        </ul>
      )}
      <div className="pptx-pagination">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={interactionBlocked || index === 0}
          onClick={() => select(index - 1)}
        >
          {S.previous}
        </button>
        <label>
          {S.select}
          <select
            aria-label={S.select}
            value={index}
            disabled={interactionBlocked}
            onChange={(event) => select(Number(event.currentTarget.value))}
          >
            {preview.slides.map((slide, at) => (
              <option key={slide.id} value={at}>
                {S.slide(at + 1)}
              </option>
            ))}
          </select>
        </label>
        <span role="status">{S.page(index + 1, preview.slides.length)}</span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={interactionBlocked || index + 1 === preview.slides.length}
          onClick={() => select(index + 1)}
        >
          {S.next}
        </button>
      </div>
      {integrated && (
        <div className="ac-actions pptx-feedback-controls">
          <button
            type="button"
            className="btn btn-ghost"
            ref={feedbackButton}
            disabled={!feedbackCurrent()}
            aria-pressed={Boolean(
              feedback && liveFeedback.current?.source === feedback,
            )}
            onClick={() => {
              if (!feedbackCurrent()) return;
              retireFeedback();
              if (!feedbackCurrent()) return;
              const source = createPptxFeedbackSource({
                preview,
                slide,
                expectedFile: preview.file,
              });
              if (!source || !resources) return;
              liveFeedback.current = {
                source,
                selection: selectionToken,
                resource: resources.token,
              };
              setFeedback(source);
              latest.current.onOfficeTargetAvailability?.({
                source,
                available: true,
              });
            }}
          >
            {S.selectFeedback}
          </button>
          {feedback && liveFeedback.current?.source === feedback && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!feedbackCurrent()}
                onClick={() => {
                  if (
                    !feedbackCurrent() ||
                    liveFeedback.current?.source !== feedback ||
                    liveFeedback.current.selection !== selectionToken ||
                    liveFeedback.current.resource !== resources?.token
                  )
                    return;
                  const anchor = pptxFeedbackTarget(feedback);
                  if (anchor)
                    latest.current.onOfficeTargetConfirm?.({
                      source: feedback,
                      anchor,
                    });
                }}
              >
                {S.confirmFeedback}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!feedbackCurrent()}
                onClick={() => {
                  if (
                    !feedbackCurrent() ||
                    liveFeedback.current?.source !== feedback
                  )
                    return;
                  retireFeedback();
                  setFeedback(null);
                  if (feedbackCurrent() && feedbackButton.current?.isConnected)
                    feedbackButton.current.focus({ preventScroll: true });
                }}
              >
                {S.cancelFeedback}
              </button>
              <span className="pptx-scope">{S.feedbackScope}</span>
            </>
          )}
        </div>
      )}
      <div className="pptx-viewport" ref={viewport}>
        <div
          className="pptx-frame"
          style={{
            width: preview.width * scale,
            height: preview.height * scale,
          }}
        >
          <div
            className="pptx-slide"
            role="group"
            aria-label={S.slide(index + 1)}
            style={{
              width: preview.width,
              height: preview.height,
              backgroundColor: slide.background,
              transform: `scale(${scale})`,
            }}
          >
            {slide.shapes.map((shape) => (
              <Shape
                key={shape.id}
                shape={shape}
                url={
                  resources?.slide === slide && shape.kind === "image"
                    ? resources.urls.get(shape.imageId)
                    : undefined
                }
                onError={() => {
                  if (
                    current() &&
                    lease.current === resources?.token &&
                    resources?.slide === slide
                  ) {
                    // Revoke before the parent's queued failed-state render.
                    // An error followed by confirm in this same tick is stale.
                    lease.current = null;
                    retireFeedback();
                    if (current()) latest.current.onImageFailure();
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
