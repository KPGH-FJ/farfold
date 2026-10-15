import { useLayoutEffect, useRef, useState } from "react";
import type { VerifiedFile } from "../runtime/file_delivery";
import {
  PptxError,
  type PptxCapture,
  type PptxPreview,
} from "../runtime/pptx_types";
import { readPptxCapture, readPptxPreview } from "../runtime/pptx_preview";
import { PPTX_STRINGS as S, pptxFailure } from "../runtime/pptx_strings";
import {
  PreviewCapture,
  samePreviewFile,
  type PreviewContentStatus,
} from "../runtime/preview_capture";
import type { PreparedPptxPreview } from "../runtime/office_preview_prepare";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
import { PptxSlideView } from "./PptxSlideView";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import "./PptxFilePreview.css";

/** Presentation cancellation retires the Worker, never its unfinished OS read. */
export function PptxFilePreview({
  file,
  active,
  readingPosition,
  prepared,
  onStatus,
  interactionBlocked = false,
  onOfficeTargetAvailability,
  onOfficeTargetConfirm,
}: {
  file: VerifiedFile;
  active: boolean;
  readingPosition?: PreviewReadingPositionRef;
  prepared?: PreparedPptxPreview;
  onStatus?: (status: PreviewContentStatus) => void;
  interactionBlocked?: boolean;
  onOfficeTargetAvailability?: (value: OfficeTargetAvailability) => void;
  onOfficeTargetConfirm?: (value: OfficeTargetConfirmation) => void;
}) {
  const props = useRef({ file, active, interactionBlocked });
  props.current = { file, active, interactionBlocked };
  const status = useRef(onStatus);
  status.current = onStatus;
  const current = useRef<AbortController | null>(null);
  const captureReader = useRef(new PreviewCapture<PptxCapture>());
  const flight = useRef<{
    file: VerifiedFile;
    promise: Promise<PptxCapture>;
  } | null>(null);
  const cached = useRef<{ file: VerifiedFile; value: PptxPreview } | null>(
    null,
  );
  const [loaded, setLoaded] = useState<{
    file: VerifiedFile;
    value: PptxPreview;
    retry: number;
    prepared?: PreparedPptxPreview;
  } | null>(null);
  const [state, setState] = useState<PreviewContentStatus["state"]>("loading");
  const [message, setMessage] = useState<string>(S.loading);
  const [retry, setRetry] = useState(0);
  const attempt = useRef({ retry, prepared });
  attempt.current = { retry, prepared };
  const shown = useRef({ loaded, state });
  shown.current = { loaded, state };
  const reading = () =>
    Boolean(flight.current && samePreviewFile(flight.current.file, file));
  useLayoutEffect(() => {
    const operation = new AbortController();
    current.current = operation;
    const owns = () =>
      current.current === operation &&
      !operation.signal.aborted &&
      props.current.file === file &&
      props.current.active;
    if (!active) {
      setState("paused");
      setMessage(S.paused);
      status.current?.({ file, state: "paused", readInFlight: reading() });
    } else {
      setState("loading");
      setMessage(S.loading);
      status.current?.({ file, state: "loading", readInFlight: reading() });
      void (async () => {
        await Promise.resolve();
        if (!owns()) return;
        let value: PptxPreview;
        if (
          prepared &&
          samePreviewFile(prepared.file, file) &&
          samePreviewFile(prepared.value.file, file)
        )
          value = prepared.value;
        else if (cached.current?.file === file) value = cached.current.value;
        else {
          cached.current = null;
          setLoaded(null);
          const pending = captureReader.current.read(
            file,
            retry,
            readPptxCapture,
          );
          flight.current = { file, promise: pending };
          status.current?.({ file, state: "loading", readInFlight: true });
          let capture: PptxCapture;
          try {
            capture = await pending;
          } finally {
            if (flight.current?.promise === pending) {
              flight.current = null;
              if (props.current.file === file && !owns())
                status.current?.({
                  file,
                  state: "paused",
                  readInFlight: false,
                });
            }
          }
          if (!owns()) return;
          status.current?.({ file, state: "loading", readInFlight: false });
          value = await readPptxPreview(capture, operation.signal);
          if (!owns()) return;
          captureReader.current.release(file);
        }
        if (!owns()) return;
        cached.current = { file, value };
        setLoaded({ file, value, retry, prepared });
        setState("ready");
        status.current?.({ file, state: "ready", readInFlight: false });
      })().catch((error) => {
        const code = error instanceof PptxError ? error.code : undefined;
        if (
          props.current.file === file &&
          attempt.current.retry === retry &&
          attempt.current.prepared === prepared &&
          (owns() || code === "readPending" || code === "readBusy")
        )
          status.current?.({
            file,
            state: "failed",
            readInFlight: reading(),
            ...(code ? { code } : {}),
          });
        if (!owns()) return;
        setState("failed");
        setMessage(pptxFailure(error));
      });
    }
    return () => {
      operation.abort();
      if (current.current === operation) current.current = null;
    };
  }, [file, active, retry, prepared]);
  const sourceCurrent = () =>
    props.current.file === file &&
    props.current.active &&
    attempt.current.retry === retry &&
    attempt.current.prepared === prepared;
  const controlsCurrent = () =>
    sourceCurrent() && !props.current.interactionBlocked;
  const ready =
    active &&
    state === "ready" &&
    loaded?.file === file &&
    loaded.retry === retry &&
    loaded.prepared === prepared
      ? loaded.value
      : null;
  return (
    <section
      className="pptx-preview"
      aria-label={S.title}
      aria-busy={active && state === "loading"}
      inert={interactionBlocked}
    >
      {state === "loading" && active && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (!controlsCurrent() || shown.current.state !== "loading") return;
            current.current?.abort();
            current.current = null;
            setState("paused");
            setMessage(S.cancelled);
            status.current?.({
              file,
              state: "paused",
              readInFlight: reading(),
            });
          }}
        >
          {S.cancel}
        </button>
      )}
      {active && (state === "failed" || state === "paused") && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (
              controlsCurrent() &&
              ["failed", "paused"].includes(shown.current.state)
            )
              setRetry((n) => n + 1);
          }}
        >
          {S.retry}
        </button>
      )}
      {!ready && (
        <p role={state === "failed" ? "alert" : "status"}>{message}</p>
      )}
      {ready && (
        <PptxSlideView
          preview={ready}
          readingPosition={readingPosition}
          interactionBlocked={interactionBlocked}
          onOfficeTargetAvailability={onOfficeTargetAvailability}
          onOfficeTargetConfirm={onOfficeTargetConfirm}
          isCurrent={() =>
            sourceCurrent() &&
            shown.current.state === "ready" &&
            shown.current.loaded === loaded &&
            current.current !== null &&
            !current.current.signal.aborted
          }
          onImageFailure={() => {
            if (
              !sourceCurrent() ||
              shown.current.loaded !== loaded ||
              shown.current.state !== "ready"
            )
              return;
            cached.current = null;
            setState("failed");
            setMessage(S.imageFailed);
            status.current?.({
              file,
              state: "failed",
              code: "invalid",
              readInFlight: false,
            });
          }}
        />
      )}
    </section>
  );
}
