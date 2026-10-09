import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TextBlockPreview as Block } from "../runtime/text_block_preview";
import { TextBlockReader } from "../runtime/text_block_reader";
import { TEXT_BLOCK_STRINGS as S } from "../runtime/text_block_strings";
import {
  saveReadingPosition,
  type PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";
import type { PreviewContentStatus } from "../runtime/preview_capture";
import "./TextBlockPreview.css";
export interface TextBlockPreviewProps {
  initial: Block;
  active: boolean;
  readingPosition?: PreviewReadingPositionRef;
  onStatus?: (status: PreviewContentStatus) => void;
}
export function TextBlockPreview({
  initial,
  active,
  readingPosition,
  onStatus,
}: TextBlockPreviewProps) {
  const readerRef = useRef<TextBlockReader | null>(null);
  const initialRef = useRef(initial);
  if (!readerRef.current || initialRef.current !== initial) {
    readerRef.current = new TextBlockReader(initial);
    initialRef.current = initial;
  }
  const reader = readerRef.current;
  const state = useSyncExternalStore(
    reader.subscribe,
    reader.snapshot,
    reader.snapshot,
  );
  const props = useRef({ active, onStatus });
  props.current = { active, onStatus };
  const [input, setInput] = useState(String(state.block.blockIndex + 1));
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copying = useRef(false);
  const mounted = useRef(true);
  const content = useRef<HTMLPreElement>(null);
  useEffect(() => {
    mounted.current = true;
    reader.onStatus = (s) => props.current.onStatus?.(s);
    reader.onStatus({
      file: initial.file,
      state: reader.snapshot().phase,
      code: reader.snapshot().code,
      readInFlight: reader.isBusy(),
    });
    return () => {
      mounted.current = false;
      reader.onStatus = undefined;
      reader.setActive(false);
    };
  }, [reader, initial.file]);
  useEffect(() => {
    reader.setActive(active);
  }, [active, reader]);
  useEffect(() => {
    saveReadingPosition(readingPosition, initial.file, {
      kind: "text",
      blockIndex: state.block.blockIndex,
    });
    setInput(String(state.block.blockIndex + 1));
    setCopyNote(null);
    if (content.current) content.current.scrollTop = 0;
  }, [state.block, initial.file, readingPosition]);
  const busy = reader.isBusy();
  const disabled = !active || busy;
  const go = (index: number) => {
    if (props.current.active) void reader.go(index);
  };
  const b = state.block;
  return (
    <section className="text-block-preview" aria-label={S.title}>
      <p>{S.scope}</p>
      <p data-block-range>{S.range(b)}</p>
      {(b.startsMidLine || b.endsMidLine) && <p>{S.continuation(b)}</p>}
      <div className="text-block-controls">
        <button
          type="button"
          className="btn btn-text"
          disabled={disabled || b.blockIndex === 0}
          onClick={() => go(b.blockIndex - 1)}
        >
          {S.previous}
        </button>
        <button
          type="button"
          className="btn btn-text"
          disabled={disabled || b.blockIndex + 1 === b.blockCount}
          onClick={() => go(b.blockIndex + 1)}
        >
          {S.next}
        </button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (/^[1-9]\d*$/.test(input)) go(Number(input) - 1);
          }}
        >
          <label>
            {S.position}
            <input
              type="number"
              min={1}
              max={b.blockCount}
              step={1}
              disabled={disabled}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn btn-text"
            disabled={
              disabled ||
              !/^[1-9]\d*$/.test(input) ||
              Number(input) > b.blockCount
            }
          >
            {S.go}
          </button>
        </form>
        <button
          type="button"
          className="btn btn-text"
          disabled={!active || copying.current}
          onClick={() => {
            if (!props.current.active || copying.current) return;
            const target = reader.snapshot().block;
            copying.current = true;
            void navigator.clipboard
              .writeText(target.text)
              .then(
                () => {
                  if (
                    mounted.current &&
                    readerRef.current === reader &&
                    props.current.active &&
                    reader.snapshot().block === target
                  )
                    setCopyNote(S.copied);
                },
                () => {
                  if (
                    mounted.current &&
                    readerRef.current === reader &&
                    reader.snapshot().block === target
                  )
                    setCopyNote(S.copyFailed);
                },
              )
              .finally(() => {
                copying.current = false;
              });
          }}
        >
          {S.copy}
        </button>
        {busy && (
          <button
            type="button"
            className="btn btn-text"
            disabled={!active || state.phase === "paused"}
            onClick={reader.cancel}
          >
            {S.cancel}
          </button>
        )}
        {(state.phase === "failed" || state.phase === "paused") && (
          <button
            type="button"
            className="btn btn-text"
            disabled={disabled}
            onClick={() => go(state.requested ?? b.blockIndex)}
          >
            {S.retry}
          </button>
        )}
      </div>
      {(state.phase !== "ready" || copyNote) && (
        <p role="status">
          {state.phase === "loading"
            ? S.loading
            : state.phase === "failed"
              ? S.failures[state.code ?? "unavailable"]
              : state.phase === "paused"
                ? `${S.paused}${busy ? S.waiting : ""}`
                : copyNote}
        </p>
      )}
      <pre ref={content} className="a-term text-block-content" tabIndex={0}>
        {b.text}
      </pre>
    </section>
  );
}
