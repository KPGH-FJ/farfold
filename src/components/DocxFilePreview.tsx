import { useLayoutEffect, useRef, useState } from "react";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { DocxCapture, DocxPreview } from "../runtime/docx_types";
import { readDocxCapture, readDocxPreview } from "../runtime/docx_preview";
import {
  DOCUMENT_STRINGS as S,
  documentFailure,
} from "../runtime/document_strings";
import { DocxDocumentView } from "./DocxDocumentView";
import "./DocxFilePreview.css";

/** Only the parent file refresh changes the captured document version. */
export function DocxFilePreview({
  file,
  active,
}: {
  file: VerifiedFile;
  active: boolean;
}) {
  const props = useRef({ file, active });
  props.current = { file, active };
  const current = useRef<AbortController | null>(null);
  const capture = useRef<{ file: VerifiedFile; value: DocxCapture } | null>(
    null,
  );
  const cached = useRef<{ file: VerifiedFile; value: DocxPreview } | null>(
    null,
  );
  const [loaded, setLoaded] = useState<typeof cached.current>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed" | "paused">(
    "loading",
  );
  const [message, setMessage] = useState<string>(S.loading);
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    const operation = new AbortController();
    current.current = operation;
    const owns = () =>
      current.current === operation &&
      !operation.signal.aborted &&
      props.current.file === file &&
      props.current.active;
    if (!active) {
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
    void (async () => {
      // StrictMode's discarded effect cannot start a second OS read.
      await Promise.resolve();
      if (!owns()) return;
      if (cached.current?.file === file) {
        setLoaded(cached.current);
        setState("ready");
        return;
      }
      cached.current = null;
      setLoaded(null);
      const snapshot =
        capture.current?.file === file
          ? capture.current.value
          : await readDocxCapture(file, operation.signal);
      if (!owns()) return;
      capture.current = { file, value: snapshot };
      const value = await readDocxPreview(snapshot, operation.signal);
      if (!owns()) return;
      capture.current = null;
      const result = { file, value };
      cached.current = result;
      setLoaded(result);
      setState("ready");
    })().catch((error) => {
      if (!owns()) return;
      setState("failed");
      setMessage(documentFailure(error));
    });
    return () => {
      operation.abort();
      if (current.current === operation) current.current = null;
    };
  }, [file, active, retry]);
  const ready =
    active && state === "ready" && loaded?.file === file ? loaded.value : null;
  return (
    <section
      className="document-preview"
      aria-label={S.title}
      aria-busy={active && state === "loading"}
    >
      {state === "loading" && active && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            current.current?.abort();
            current.current = null;
            capture.current = null;
            setState("paused");
            setMessage(S.cancelled);
          }}
        >
          {S.cancel}
        </button>
      )}
      {active && (state === "failed" || state === "paused") && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setRetry((n) => n + 1)}
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
        />
      )}
    </section>
  );
}
