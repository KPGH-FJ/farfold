import { useLayoutEffect, useRef, useState, type Ref } from "react";
import {
  textFeedbackLineOffsets,
  textFeedbackRange,
  type TextFeedbackSource,
} from "../runtime/text_feedback_range";
import type { TextRangeAnchor } from "../runtime/file_feedback_anchor";
import { SOURCE_TEXT_SELECTION_STRINGS as S } from "../runtime/source_text_selection_strings";
import { sourceDomOffsets, sourceDomRange } from "./source_text_dom";
import "./SourceTextSelection.css";

export interface TextSelectionAvailability {
  source: TextFeedbackSource;
  available: boolean;
}
export interface TextSelectionConfirmation {
  source: TextFeedbackSource;
  anchor: TextRangeAnchor;
}
export interface SourceTextSelectionProps {
  source: TextFeedbackSource;
  enabled: boolean;
  contentRef?: Ref<HTMLPreElement>;
  className?: string;
  onAvailability?: (value: TextSelectionAvailability) => void;
  onConfirm: (value: TextSelectionConfirmation) => void;
}
interface Candidate extends TextSelectionConfirmation {
  range: Range;
}

/** A temporary DOM selection, never a persisted body or an editable document. */
export function SourceTextSelection(props: SourceTextSelectionProps) {
  const current = useRef(props);
  current.current = props;
  const container = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const focusAction = useRef(false);
  const candidate = useRef<Candidate | null>(null);
  const [shownCandidate, setShownCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState(false);
  const [first, setFirst] = useState(String(props.source.startLine));
  const [last, setLast] = useState(String(props.source.startLine));

  const publish = (next: Candidate | null, render = true) => {
    const previous = candidate.current;
    candidate.current = next;
    if (render) setShownCandidate(next);
    if (previous && previous.source !== next?.source)
      current.current.onAvailability?.({
        source: previous.source,
        available: false,
      });
    if (next && previous?.source !== next.source)
      current.current.onAvailability?.({
        source: next.source,
        available: true,
      });
  };
  const validate = (range: Range, source = current.current.source) => {
    const root = pre.current;
    if (!root || !current.current.enabled || source !== current.current.source)
      return null;
    const offsets = sourceDomOffsets(root, range, source.text);
    const anchor =
      offsets && textFeedbackRange(source, offsets.start, offsets.end);
    return anchor ? { source, anchor, range: range.cloneRange() } : null;
  };
  const capture = () => {
    const selection = pre.current?.ownerDocument.getSelection();
    if (!selection || selection.rangeCount !== 1) {
      publish(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const next = validate(range);
    if (next) {
      setError(false);
      publish(next);
      return;
    }
    // Tab/click into our controls may collapse the visible browser selection.
    // Retain its exact cloned Range only while focus remains in this component.
    const focused = pre.current?.ownerDocument.activeElement;
    if (
      selection.isCollapsed &&
      focused &&
      container.current?.contains(focused) &&
      focused !== pre.current
    )
      return;
    publish(null);
  };
  const clearBrowserSelection = () => {
    const root = pre.current;
    const selection = root?.ownerDocument.getSelection();
    if (root && selection?.rangeCount === 1) {
      const range = selection.getRangeAt(0);
      if (
        root.contains(range.startContainer) &&
        root.contains(range.endContainer)
      )
        selection.removeAllRanges();
    }
  };
  useLayoutEffect(() => {
    clearBrowserSelection();
    publish(null);
    setError(false);
    setFirst(String(props.source.startLine));
    setLast(String(props.source.startLine));
    const doc = pre.current?.ownerDocument;
    const blur = () => publish(null);
    const outside = (event: PointerEvent) => {
      if (event.target && !container.current?.contains(event.target as Node))
        publish(null);
    };
    if (props.enabled) {
      doc?.addEventListener("selectionchange", capture);
      doc?.addEventListener("pointerdown", outside, true);
      doc?.defaultView?.addEventListener("blur", blur);
    }
    return () => {
      doc?.removeEventListener("selectionchange", capture);
      doc?.removeEventListener("pointerdown", outside, true);
      doc?.defaultView?.removeEventListener("blur", blur);
      publish(null, false);
    };
  }, [props.source, props.enabled]);
  useLayoutEffect(() => {
    if (shownCandidate && focusAction.current) {
      focusAction.current = false;
      if (candidate.current !== shownCandidate) return;
      const button = action.current;
      if (!button || !validate(shownCandidate.range, shownCandidate.source)) {
        publish(null);
        return;
      }
      button.focus();
      if (candidate.current !== shownCandidate) return;
      // WebKit clears the page selection when a number input loses focus.
      // Recheck the same candidate after our focus handoff, then display it.
      // Ordinary empty selections still clear candidates in capture().
      const next = validate(shownCandidate.range, shownCandidate.source);
      const doc = pre.current?.ownerDocument;
      const selection = doc?.getSelection();
      if (!next || !selection || doc?.activeElement !== button) {
        publish(null);
        return;
      }
      selection.removeAllRanges();
      selection.addRange(next.range);
    }
  }, [shownCandidate]);
  const available = props.enabled && shownCandidate?.source === props.source;
  const selectable = props.enabled && props.source.text.length > 0;
  const partial =
    props.source.byteStart > 0 || props.source.byteEnd < props.source.file.size;
  return (
    <div
      className="source-text-selection"
      ref={container}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          publish(null);
      }}
    >
      <div className="source-text-selection-controls">
        <p>{S.hint}</p>
        <details>
          <summary>{S.keyboard}</summary>
          <p>
            {props.source.text
              ? S.range(props.source.startLine, props.source.endLine)
              : S.empty}
          </p>
          {partial && <p>{S.fragment}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!current.current.enabled) return;
              const source = current.current.source;
              const offsets =
                /^[1-9]\d*$/.test(first) && /^[1-9]\d*$/.test(last)
                  ? textFeedbackLineOffsets(source, Number(first), Number(last))
                  : null;
              const range =
                offsets &&
                pre.current &&
                sourceDomRange(
                  pre.current,
                  source.text,
                  offsets.start,
                  offsets.end,
                );
              const next = range && validate(range, source);
              const selection = pre.current?.ownerDocument.getSelection();
              if (!next || !selection) {
                publish(null);
                setError(true);
                return;
              }
              selection.removeAllRanges();
              focusAction.current = true;
              publish(next);
              setError(false);
            }}
          >
            <label>
              {S.startLine}
              <input
                type="number"
                min={props.source.startLine}
                max={props.source.endLine}
                step={1}
                value={first}
                disabled={!selectable}
                onChange={(e) => setFirst(e.target.value)}
              />
            </label>
            <label>
              {S.endLine}
              <input
                type="number"
                min={props.source.startLine}
                max={props.source.endLine}
                step={1}
                value={last}
                disabled={!selectable}
                onChange={(e) => setLast(e.target.value)}
              />
            </label>
            <button
              className="btn btn-text"
              type="submit"
              disabled={!selectable}
            >
              {S.selectLines}
            </button>
          </form>
        </details>
        <span role="status">
          {error
            ? S.invalid
            : available && shownCandidate
              ? S.selected(
                  shownCandidate.anchor.startLine,
                  shownCandidate.anchor.endLine,
                )
              : ""}
        </span>
        <button
          ref={action}
          type="button"
          className="btn btn-text"
          disabled={!available}
          onPointerDown={(event) => {
            if (available) event.preventDefault();
          }}
          onClick={() => {
            const previous = candidate.current;
            const next = previous && validate(previous.range, previous.source);
            if (!next) {
              publish(null);
              return;
            }
            current.current.onConfirm({
              source: next.source,
              anchor: next.anchor,
            });
            clearBrowserSelection();
            publish(null);
          }}
        >
          {S.confirm}
        </button>
      </div>
      <pre
        ref={(node) => {
          pre.current = node;
          const ref = current.current.contentRef;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        className={props.className ?? "a-term"}
        aria-label={S.source}
        tabIndex={0}
        onPointerUp={capture}
        onKeyUp={capture}
      >
        {props.source.text}
      </pre>
    </div>
  );
}
