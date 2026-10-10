import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from "react";
import type { VisualPreview } from "../runtime/file_delivery";
import type { FileTargetEditing } from "../runtime/file_target_editing";
import {
  VISUAL_AREA_SCALE,
  parseVisualAreaPercent,
  formatVisualAreaPercent,
  validVisualAreaRect,
  visualAreaRectFromPoints,
  type VisualAreaRect,
} from "../runtime/visual_area_coordinates";
import {
  registerVisualFeedbackFrame,
  retireVisualFeedbackFrame,
  createVisualAreaFeedbackSource,
  retireVisualAreaFeedbackSource,
  visualAreaFeedbackTarget,
  visualAreaFeedbackSourceIsValid,
  type VisualFeedbackFrame,
  type VisualFeedbackFrameInput,
  type VisualAreaFeedbackSource,
  type VisualTargetAvailability,
  type VisualTargetConfirmation,
} from "../runtime/visual_feedback_target";
import { VISUAL_AREA_STRINGS as S } from "../runtime/visual_area_strings";

export type VisualAreaDisplay = Readonly<
  {
    owner: object;
    preview: VisualPreview;
    element: HTMLCanvasElement | HTMLImageElement;
    pixelWidth: number;
    pixelHeight: number;
  } & ({ kind: "image" } | { kind: "pdf"; page: number; pageCount: number })
>;
export type VisualAreaCallbacks = {
  onVisualTargetAvailability?: (value: VisualTargetAvailability) => void;
  onVisualTargetConfirm?: (value: VisualTargetConfirmation) => void;
  onTargetEditing?: (value: FileTargetEditing) => void;
};
type Props = VisualAreaCallbacks & {
  preview: VisualPreview;
  display: VisualAreaDisplay | null;
  interactionBlocked: boolean;
  isCurrent: (display: VisualAreaDisplay) => boolean;
  children: ReactNode;
};
type Values = { left: string; top: string; right: string; bottom: string };
type Editor = {
  display: VisualAreaDisplay;
  values: Values;
  selection: VisualAreaRect | null;
  error: string | null;
};
type Box = {
  left: number;
  top: number;
  width: number;
  height: number;
  dpr: number;
};
const fields = ["left", "top", "right", "bottom"] as const;
function bounds(display: VisualAreaDisplay): Box | null {
  const rect = display.element.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return display.element.isConnected &&
    [rect.left, rect.top, rect.width, rect.height, dpr].every(
      Number.isFinite,
    ) &&
    rect.width > 0 &&
    rect.height > 0 &&
    dpr > 0
    ? {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        dpr,
      }
    : null;
}
const sameSize = (a: Box, b: Box) =>
  a.width === b.width && a.height === b.height && a.dpr === b.dpr;
const sameBox = (a: Box, b: Box) =>
  sameSize(a, b) && a.left === b.left && a.top === b.top;

/** One transient rectangle on the actual displayed pixels; never a file editor. */
export function VisualAreaSelection(props: Props) {
  const { preview, display, interactionBlocked } = props;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [frame, setFrame] = useState<VisualFeedbackFrame | null>(null);
  const [shown, setShown] = useState<VisualAreaFeedbackSource | null>(null);
  const [dragArea, setDragArea] = useState<VisualAreaRect | null>(null);
  const mounted = useRef(false);
  const entry = useRef<HTMLButtonElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const focusConfirmation = useRef<Editor | null>(null);
  const focusEntry = useRef<VisualAreaDisplay | null>(null);
  const feedback = useRef<VisualAreaFeedbackSource | null>(null);
  const geometryOwner = useRef<object | null>(null);
  const geometrySnapshot = useRef<{
    display: VisualAreaDisplay;
    box: Box;
  } | null>(null);
  const live = useRef<{
    display: VisualAreaDisplay;
    box: Box;
    frame: VisualFeedbackFrame;
  } | null>(null);
  const drag = useRef<{
    id: number;
    box: Box;
    start: { x: number; y: number };
    editor: Editor;
    display: VisualAreaDisplay;
    target: HTMLDivElement;
  } | null>(null);
  const current = useRef({ props, editor });
  current.current = { props, editor };
  const open = Boolean(display && editor?.display === display);
  const ownsDisplay = (expected: VisualAreaDisplay) =>
    mounted.current &&
    current.current.props.display === expected &&
    current.current.props.preview === preview &&
    expected.preview === preview &&
    current.current.props.isCurrent(expected);
  const allowed = () =>
    Boolean(
      display &&
      ownsDisplay(display) &&
      !current.current.props.interactionBlocked &&
      current.current.editor === editor &&
      editor?.display === display,
    );
  const retire = () => {
    const old = feedback.current;
    feedback.current = null;
    if (!old) return;
    retireVisualAreaFeedbackSource(old);
    setShown(null);
    current.current.props.onVisualTargetAvailability?.({
      source: old,
      available: false,
    });
  };
  const stopDrag = () => {
    const old = drag.current;
    drag.current = null;
    setDragArea(null);
    if (old)
      try {
        old.target.releasePointerCapture(old.id);
      } catch {
        /* Already lost. */
      }
  };
  const change = (next: Editor | null) => {
    current.current.editor = next;
    setEditor(next);
    focusConfirmation.current = null;
    focusEntry.current = null;
    retire();
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopDrag();
      retire();
    };
  }, []);
  useLayoutEffect(() => {
    let disposed = false;
    let previousBox: Box | null =
      geometrySnapshot.current?.display === display
        ? geometrySnapshot.current.box
        : null;
    const retireFrame = () => {
      const old = live.current;
      live.current = null;
      geometryOwner.current = null;
      if (old) retireVisualFeedbackFrame(old.frame);
      retire();
      setFrame(null);
    };
    const refresh = () => {
      if (disposed) return;
      if (
        !display ||
        !ownsDisplay(display) ||
        current.current.props.interactionBlocked
      ) {
        retireFrame();
        return;
      }
      const box = bounds(display);
      if (box && previousBox && sameSize(box, previousBox) && live.current)
        return;
      if (previousBox && (!box || !sameSize(box, previousBox))) {
        stopDrag();
        const previous = current.current.editor;
        if (previous?.display === display)
          change({ ...previous, selection: null, error: S.changed });
      }
      retireFrame();
      if (
        !box ||
        !ownsDisplay(display) ||
        current.current.props.interactionBlocked
      )
        return;
      previousBox = box;
      geometrySnapshot.current = { display, box };
      const token = {};
      geometryOwner.current = token;
      const input: VisualFeedbackFrameInput = {
        preview,
        expectedFile: preview.file,
        drawOwner: display.owner,
        pixelWidth: display.pixelWidth,
        pixelHeight: display.pixelHeight,
        ...(display.kind === "pdf"
          ? { kind: "pdf", page: display.page, pageCount: display.pageCount }
          : { kind: "image" }),
        isCurrent: () => {
          const now = bounds(display);
          return Boolean(
            ownsDisplay(display) &&
            !current.current.props.interactionBlocked &&
            geometryOwner.current === token &&
            now &&
            sameSize(now, box),
          );
        },
      };
      const created = registerVisualFeedbackFrame(input);
      if (created) {
        live.current = { display, box, frame: created };
        setFrame(created);
      }
    };
    refresh();
    const observer =
      display && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(refresh)
        : null;
    if (display) observer?.observe(display.element);
    window.addEventListener("resize", refresh);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", refresh);
      stopDrag();
      retireFrame();
    };
  }, [preview, display, interactionBlocked]);
  useLayoutEffect(() => {
    if (!open || !display) return;
    const owner = {};
    const callback = current.current.props.onTargetEditing;
    callback?.({ owner, file: preview.file, editing: true });
    if (
      ownsDisplay(display) &&
      !current.current.props.interactionBlocked &&
      current.current.editor?.display === display
    )
      firstInput.current?.focus({ preventScroll: true });
    return () => {
      stopDrag();
      retire();
      callback?.({ owner, file: preview.file, editing: false });
    };
  }, [preview, display, open]);
  useLayoutEffect(() => {
    const selection = editor?.selection;
    if (
      frame &&
      open &&
      selection &&
      allowed() &&
      live.current?.frame === frame
    ) {
      const source = createVisualAreaFeedbackSource({
        frame,
        selection,
        expectedFile: preview.file,
      });
      if (source) {
        feedback.current = source;
        setShown(source);
        current.current.props.onVisualTargetAvailability?.({
          source,
          available: true,
        });
      }
    }
    return retire;
  }, [preview, display, editor, frame, open, interactionBlocked]);
  useLayoutEffect(() => {
    if (
      focusConfirmation.current !== editor ||
      !shown ||
      !allowed() ||
      feedback.current !== shown ||
      !visualAreaFeedbackSourceIsValid(shown)
    )
      return;
    focusConfirmation.current = null;
    confirm.current?.focus({ preventScroll: true });
  }, [editor, shown]);
  const submit = (selection: VisualAreaRect, values?: Values) => {
    if (!allowed() || !display) return;
    const next: Editor = {
      display,
      selection: Object.freeze({ ...selection }),
      error: null,
      values:
        values ??
        (Object.fromEntries(
          fields.map((key) => [key, formatVisualAreaPercent(selection[key])]),
        ) as Values),
    };
    change(next);
    if (
      ownsDisplay(display) &&
      !current.current.props.interactionBlocked &&
      current.current.editor === next
    )
      focusConfirmation.current = next;
  };
  const cancel = () => {
    if (!allowed() || !display) return;
    stopDrag();
    change(null);
    if (
      ownsDisplay(display) &&
      !current.current.props.interactionBlocked &&
      current.current.editor === null
    )
      focusEntry.current = display;
  };
  useLayoutEffect(() => {
    const expected = focusEntry.current;
    if (!expected || open) return;
    focusEntry.current = null;
    if (
      display === expected &&
      ownsDisplay(expected) &&
      !current.current.props.interactionBlocked &&
      current.current.editor === null
    )
      entry.current?.focus({ preventScroll: true });
  }, [display, open]);
  const dragPosition = (
    event: PointerEvent<HTMLDivElement>,
    state: NonNullable<typeof drag.current>,
  ) => {
    const box = bounds(state.display);
    if (!box || !sameBox(box, state.box)) return null;
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    };
  };
  const overlay =
    dragArea ??
    (open && shown && feedback.current === shown ? editor?.selection : null);
  return (
    <>
      {display && (
        <div className="visual-area-controls">
          {!open && (
            <button
              ref={entry}
              type="button"
              className="btn btn-text"
              disabled={interactionBlocked || !frame}
              onClick={() => {
                if (
                  !ownsDisplay(display) ||
                  current.current.props.interactionBlocked ||
                  !live.current ||
                  current.current.editor?.display === display
                )
                  return;
                change({
                  display,
                  values: { left: "", top: "", right: "", bottom: "" },
                  selection: null,
                  error: null,
                });
              }}
            >
              {S.open}
            </button>
          )}
          {open && editor && (
            <div
              className="visual-area-editor"
              inert={interactionBlocked}
              onKeyDown={(event) => {
                if (event.key === "Escape" && allowed()) {
                  event.preventDefault();
                  cancel();
                }
              }}
            >
              <p>{S.scope}</p>
              <form
                aria-label={S.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!allowed()) return;
                  const parsed = Object.fromEntries(
                    fields.map((key) => [
                      key,
                      parseVisualAreaPercent(editor.values[key]),
                    ]),
                  );
                  if (!validVisualAreaRect(parsed)) {
                    change({ ...editor, selection: null, error: S.invalid });
                    return;
                  }
                  submit(parsed, editor.values);
                }}
              >
                <div className="visual-area-fields">
                  {fields.map((key) => (
                    <label key={key}>
                      {S[key]}
                      <input
                        ref={key === "left" ? firstInput : undefined}
                        type="text"
                        inputMode="decimal"
                        maxLength={32}
                        value={editor.values[key]}
                        aria-label={S[key]}
                        disabled={interactionBlocked}
                        onChange={(event) => {
                          if (allowed())
                            change({
                              ...editor,
                              values: {
                                ...editor.values,
                                [key]: event.currentTarget.value,
                              },
                              selection: null,
                              error: null,
                            });
                        }}
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="submit"
                  className="btn btn-text"
                  disabled={interactionBlocked || !frame}
                >
                  {S.choose}
                </button>
              </form>
              <p role={editor.error ? "alert" : "status"}>
                {editor.error ??
                  (editor.selection && shown
                    ? S.selection(editor.selection)
                    : S.empty)}
              </p>
              <div className="visual-area-actions">
                <button
                  ref={confirm}
                  type="button"
                  className="btn btn-primary"
                  disabled={
                    interactionBlocked || !shown || feedback.current !== shown
                  }
                  onClick={() => {
                    if (
                      !allowed() ||
                      !shown ||
                      feedback.current !== shown ||
                      !visualAreaFeedbackSourceIsValid(shown)
                    )
                      return;
                    const anchor = visualAreaFeedbackTarget(shown);
                    if (!anchor) return;
                    if (
                      shown.kind === "image-area" &&
                      anchor.kind === "image-area"
                    )
                      current.current.props.onVisualTargetConfirm?.({
                        source: shown,
                        anchor,
                      });
                    else if (
                      shown.kind === "pdf-area" &&
                      anchor.kind === "pdf-area"
                    )
                      current.current.props.onVisualTargetConfirm?.({
                        source: shown,
                        anchor,
                      });
                  }}
                >
                  {S.confirm}
                </button>
                <button
                  type="button"
                  className="btn btn-text"
                  disabled={interactionBlocked}
                  onClick={cancel}
                >
                  {S.cancel}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div
        className={`visual-area-stage${open ? " is-selecting" : ""}`}
        role={open ? "group" : undefined}
        aria-label={open ? S.surface : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && allowed()) {
            event.preventDefault();
            cancel();
          }
        }}
        onPointerDown={(event) => {
          if (
            !allowed() ||
            !display ||
            !frame ||
            event.button !== 0 ||
            event.isPrimary === false ||
            drag.current
          )
            return;
          const box = bounds(display);
          if (
            !box ||
            event.clientX < box.left ||
            event.clientX > box.left + box.width ||
            event.clientY < box.top ||
            event.clientY > box.top + box.height
          )
            return;
          event.preventDefault();
          const snapshot = editor!;
          retire();
          if (!allowed() || current.current.editor !== snapshot) return;
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            return;
          }
          drag.current = {
            id: event.pointerId,
            box,
            start: {
              x: (event.clientX - box.left) / box.width,
              y: (event.clientY - box.top) / box.height,
            },
            editor: snapshot,
            display,
            target: event.currentTarget,
          };
          setDragArea(null);
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (!state || state.id !== event.pointerId) return;
          if (!allowed() || state.editor !== editor) {
            stopDrag();
            return;
          }
          const point = dragPosition(event, state);
          if (!point) {
            stopDrag();
            return;
          }
          setDragArea(visualAreaRectFromPoints(state.start, point));
        }}
        onPointerUp={(event) => {
          const state = drag.current;
          if (!state || state.id !== event.pointerId) return;
          const point =
            allowed() && state.editor === editor
              ? dragPosition(event, state)
              : null;
          const selection = point
            ? visualAreaRectFromPoints(state.start, point)
            : null;
          stopDrag();
          if (selection) submit(selection);
        }}
        onPointerCancel={() => stopDrag()}
        onLostPointerCapture={() => stopDrag()}
      >
        {props.children}
        {overlay && (
          <div
            className="visual-area-outline"
            aria-hidden="true"
            style={{
              left: `${(overlay.left / VISUAL_AREA_SCALE) * 100}%`,
              top: `${(overlay.top / VISUAL_AREA_SCALE) * 100}%`,
              width: `${((overlay.right - overlay.left) / VISUAL_AREA_SCALE) * 100}%`,
              height: `${((overlay.bottom - overlay.top) / VISUAL_AREA_SCALE) * 100}%`,
            }}
          />
        )}
      </div>
    </>
  );
}
