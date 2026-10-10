import { DocxError } from "../runtime/docx_types";
import { useLayoutEffect, useRef, useState } from "react";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { DocxCapture, DocxPreview } from "../runtime/docx_types";
import { readDocxCapture, readDocxPreview } from "../runtime/docx_preview";
import {
  DOCUMENT_STRINGS as S,
  documentFailure,
} from "../runtime/document_strings";
import { DocxDocumentView } from "./DocxDocumentView";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
import {
  PreviewCapture,
  samePreviewFile,
  type PreviewContentStatus,
} from "../runtime/preview_capture";
import type { PreparedDocxPreview } from "../runtime/office_preview_prepare";
import type {
  OfficeTargetAvailability,
  OfficeTargetConfirmation,
} from "../runtime/office_feedback_target";
import "./DocxFilePreview.css";

/** Only the parent file refresh changes the captured document version. */
export function DocxFilePreview({
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
  prepared?: PreparedDocxPreview;
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
  const captureReader = useRef(new PreviewCapture<DocxCapture>());
  const capture = useRef<{ file: VerifiedFile; value: DocxCapture } | null>(
    null,
  );
  const cached = useRef<{ file: VerifiedFile; value: DocxPreview } | null>(
    null,
  );
  const [loaded, setLoaded] = useState<{
    file: VerifiedFile;
    value: DocxPreview;
    retry: number;
    prepared: PreparedDocxPreview | undefined;
  } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "paused">(
    "loading",
  );
  const [message, setMessage] = useState<string>(S.loading);
  const [retry, setRetry] = useState(0);
  const attempt = useRef({ retry, prepared });
  attempt.current = { retry, prepared };
  const shown = useRef({ loaded, state });
  shown.current = { loaded, state };
  useLayoutEffect(() => {
    const operation = new AbortController();
    current.current = operation;
    const owns = () =>
      current.current === operation &&
      !operation.signal.aborted &&
      props.current.file === file &&
      props.current.active;
    if (!active) {
      status.current?.({ file, state: "paused" });
      capture.current = null;
      setState("paused");
      setMessage(S.paused);
      return () => {
        operation.abort();
        if (current.current === operation) current.current = null;
      };
    }
    setState("loading");
    setMessage(S.loading);
    status.current?.({ file, state: "loading" });
    void (async () => {
      // StrictMode's discarded effect cannot start a second OS read.
      await Promise.resolve();
      if (!owns()) return;
      if (
        prepared &&
        samePreviewFile(prepared.file, file) &&
        samePreviewFile(prepared.value.file, file)
      ) {
        const result = { file, value: prepared.value };
        cached.current = result;
        setLoaded({ ...result, retry, prepared });
        setState("ready");
        status.current?.({ file, state: "ready" });
        return;
      }
      if (cached.current?.file === file) {
        setLoaded({ ...cached.current, retry, prepared });
        setState("ready");
        status.current?.({ file, state: "ready" });
        return;
      }
      cached.current = null;
      setLoaded(null);
      const snapshot =
        capture.current?.file === file
          ? capture.current.value
          : await captureReader.current.read(file, retry, readDocxCapture);
      if (!owns()) return;
      capture.current = { file, value: snapshot };
      const value = await readDocxPreview(snapshot, operation.signal);
      if (!owns()) return;
      capture.current = null;
      captureReader.current.release(file);
      const result = { file, value };
      cached.current = result;
      setLoaded({ ...result, retry, prepared });
      setState("ready");
      status.current?.({ file, state: "ready" });
    })().catch((error) => {
      const code = error instanceof DocxError ? error.code : undefined;
      if (
        props.current.file === file &&
        attempt.current.retry === retry &&
        attempt.current.prepared === prepared &&
        (owns() || code === "readPending" || code === "readBusy")
      )
        status.current?.({ file, state: "failed", ...(code ? { code } : {}) });
      if (!owns()) return;
      setState("failed");
      setMessage(documentFailure(error));
    });
    return () => {
      operation.abort();
      if (current.current === operation) current.current = null;
    };
  }, [file, active, retry, prepared]);
  const ready =
    active &&
    state === "ready" &&
    loaded?.file === file &&
    loaded.retry === retry &&
    loaded.prepared === prepared
      ? loaded.value
      : null;
  const controlsCurrent = () =>
    props.current.file === file &&
    props.current.active &&
    !props.current.interactionBlocked &&
    attempt.current.retry === retry &&
    attempt.current.prepared === prepared;
  return (
    <section
      className="document-preview"
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
            capture.current = null;
            setState("paused");
            setMessage(S.cancelled);
            status.current?.({ file, state: "paused" });
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
              !controlsCurrent() ||
              !["failed", "paused"].includes(shown.current.state)
            )
              return;
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
        <DocxDocumentView
          key={`${file.resolvedPath}:${file.version}:${file.sha256}`}
          document={ready}
          readingPosition={readingPosition}
          interactionBlocked={interactionBlocked}
          isCurrent={() =>
            controlsCurrent() &&
            shown.current.state === "ready" &&
            shown.current.loaded === loaded &&
            current.current !== null &&
            !current.current.signal.aborted
          }
          onOfficeTargetAvailability={onOfficeTargetAvailability}
          onOfficeTargetConfirm={onOfficeTargetConfirm}
        />
      )}
    </section>
  );
}
