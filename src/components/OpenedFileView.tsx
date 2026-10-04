import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { save } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fileDelivery, type VerifiedFile } from "../runtime/file_delivery";
import {
  fileFeedbackDrafts,
  fileFeedbackKey,
  useFileFeedback,
} from "../runtime/drafts";
import { fileFeedbackText } from "../runtime/feedback_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";

export interface OpenedFileViewProps {
  /** The original conversation owns unsent feedback, including after refresh. */
  threadKey: string;
  /** Exact local file selected by the user; never an inferred artifact body. */
  path: string;
  workingDirectory: string;
  active: boolean;
  /** Changes for an explicit new selection, including the same path in another task. */
  selectionKey?: string;
  onOpenHtml: (file: VerifiedFile) => void;
  headerActions?: ReactNode;
  onBack?: () => void;
}

type View = {
  identity: string;
  phase: "loading" | "ready" | "failed" | "paused";
  file?: VerifiedFile;
  text?: string;
  note?: string;
  pending?: boolean;
};
type Operation = { identity: string };
const MAX_TEXT_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "json",
  "jsonl",
  "csv",
  "tsv",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "svg",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "py",
  "pyi",
  "rs",
  "go",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "java",
  "kt",
  "swift",
  "m",
  "mm",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "r",
  "vue",
  "svelte",
  "astro",
  "tex",
  "rst",
  "diff",
  "patch",
  "env",
  "gitignore",
  "gitattributes",
  "editorconfig",
]);
function extension(name: string) {
  return name.toLowerCase().split(".").pop() ?? "";
}
function isHtml(file: VerifiedFile) {
  return /\.html?$/i.test(file.name);
}
function isText(file: VerifiedFile) {
  return (
    TEXT_EXTENSIONS.has(extension(file.name)) ||
    /^(readme|license|licence|copying|notice|makefile|dockerfile)$/i.test(
      file.name,
    )
  );
}
function sameFile(left: VerifiedFile, right: VerifiedFile) {
  return (
    [
      "root",
      "path",
      "resolvedPath",
      "name",
      "size",
      "sha256",
      "version",
    ] as const
  ).every((key) => left[key] === right[key]);
}

/** A transient disk-file view. Mount/selection follows an explicit user click. */
export function OpenedFileView({
  threadKey,
  path,
  workingDirectory,
  active,
  selectionKey,
  onOpenHtml,
  headerActions,
  onBack,
}: OpenedFileViewProps) {
  const identity = JSON.stringify([
    threadKey,
    selectionKey,
    workingDirectory,
    path,
  ]);
  const currentProps = useRef({ identity, active, onOpenHtml });
  currentProps.current = { identity, active, onOpenHtml };
  const mounted = useRef(true);
  const operation = useRef<Operation | null>(null);
  const [view, setView] = useState<View>({ identity, phase: "loading" });
  const current = (owner: Operation) =>
    mounted.current &&
    currentProps.current.active &&
    currentProps.current.identity === owner.identity &&
    operation.current === owner;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      operation.current = null;
      setView((previous) =>
        previous.identity === identity &&
        (previous.phase === "loading" || previous.pending)
          ? { identity, phase: "paused" }
          : previous,
      );
    }
  }, [active, identity]);

  async function load() {
    if (
      !mounted.current ||
      !currentProps.current.active ||
      currentProps.current.identity !== identity ||
      operation.current
    )
      return;
    const owner = { identity };
    operation.current = owner;
    setView({ identity, phase: "loading" });
    try {
      const file = await fileDelivery.inspectLink(workingDirectory, path);
      if (!current(owner)) return;
      if (isHtml(file)) {
        setView({ identity, phase: "ready", file, note: S.html });
        currentProps.current.onOpenHtml(file);
      } else if (isText(file) && file.size <= MAX_TEXT_BYTES) {
        const preview = await fileDelivery.readText(file);
        if (!current(owner)) return;
        if (!sameFile(preview.file, file)) throw new Error("File changed");
        setView({
          identity,
          phase: "ready",
          file: preview.file,
          text: preview.text,
        });
      } else {
        setView({
          identity,
          phase: "ready",
          file,
          note: isText(file) ? S.large : S.other,
        });
      }
    } catch {
      if (current(owner))
        setView({ identity, phase: "failed", note: S.failed });
    } finally {
      if (operation.current === owner) operation.current = null;
    }
  }

  useEffect(() => {
    if (currentProps.current.active) void load();
    else setView({ identity, phase: "paused" });
    return () => {
      if (operation.current?.identity === identity) operation.current = null;
    };
    // Activity resumption must not repeat a previously selected HTML handoff.
  }, [identity]);

  async function act(
    action: (
      file: VerifiedFile,
      valid: () => boolean,
    ) => Promise<string | null>,
  ) {
    if (
      !mounted.current ||
      !currentProps.current.active ||
      operation.current ||
      currentProps.current.identity !== identity ||
      view.identity !== identity ||
      view.phase !== "ready" ||
      !view.file
    )
      return;
    const owner = { identity };
    operation.current = owner;
    const file = view.file;
    setView({ ...view, pending: true, note: undefined });
    try {
      const note = await action(file, () => current(owner));
      if (current(owner))
        setView({ ...view, pending: false, note: note ?? view.note });
    } catch {
      // A failed action invalidates every old receipt, including the displayed text.
      if (current(owner))
        setView({ identity, phase: "failed", note: S.actionFailed });
    } finally {
      if (operation.current === owner) operation.current = null;
    }
  }

  const shown =
    view.identity === identity ? view : { identity, phase: "loading" as const };
  const file = shown.file;
  const disabled = !active || shown.pending || shown.phase === "loading";
  const name = file?.name || path.split("/").filter(Boolean).pop() || path;
  const markdown = file && /^(md|markdown)$/i.test(extension(file.name));
  // Draft identity contains only disk revision metadata, never the displayed body.
  const contentId = file
    ? `disk:${JSON.stringify([file.resolvedPath, file.version, file.sha256])}`
    : "";
  const feedbackPath = file?.resolvedPath ?? path;
  const feedback = useFileFeedback(threadKey, feedbackPath, contentId);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackAdded, setFeedbackAdded] = useState(false);
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const feedbackOwner = JSON.stringify([identity, contentId]);
  const currentFeedback = useRef(feedbackOwner);
  currentFeedback.current = feedbackOwner;
  const canEditFeedback = () =>
    mounted.current &&
    currentProps.current.active &&
    currentProps.current.identity === identity &&
    currentFeedback.current === feedbackOwner &&
    !operation.current &&
    shown.phase === "ready" &&
    shown.text !== undefined &&
    Boolean(file);
  useEffect(() => {
    setFeedbackOpen(
      Boolean(fileFeedbackDrafts.read(threadKey, feedbackPath, contentId).text),
    );
    setFeedbackAdded(false);
  }, [threadKey, identity, feedbackPath, contentId]);
  useEffect(() => {
    if (active && feedbackOpen) feedbackInput.current?.focus();
  }, [active, feedbackOpen]);
  return (
    <section className="file-artifact-view" aria-label={S.title}>
      <div className="a-head">
        <span className="a-title artifact-file-name" title={path}>
          {name}
        </span>
        <div className="ac-actions">
          {onBack && (
            <button type="button" className="btn btn-text" onClick={onBack}>
              {S.back}
            </button>
          )}
          {headerActions}
        </div>
      </div>
      <div className="artifact-provenance">
        <details>
          <summary>{S.location}</summary>
          <p style={{ overflowWrap: "anywhere" }}>
            {file?.resolvedPath ?? path}
          </p>
        </details>
        <div className="ac-actions" style={{ flexWrap: "wrap" }}>
          {file && (
            <>
              {isHtml(file) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={disabled}
                  onClick={() => void load()}
                >
                  {S.openHtml}
                </button>
              )}
              {shown.text !== undefined && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={disabled}
                    onClick={() => void load()}
                  >
                    {S.refresh}
                  </button>
                  <button
                    type="button"
                    className="btn btn-text"
                    disabled={disabled}
                    aria-expanded={feedbackOpen}
                    onClick={() => {
                      if (canEditFeedback()) setFeedbackOpen(!feedbackOpen);
                    }}
                  >
                    {S.feedback}
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                onClick={() =>
                  void act(async (value) => {
                    await fileDelivery.open(value);
                    return S.opened;
                  })
                }
              >
                {S.open}
              </button>
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                onClick={() =>
                  void act(async (value) => {
                    await fileDelivery.reveal(value);
                    return S.revealed;
                  })
                }
              >
                {S.reveal}
              </button>
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                onClick={() =>
                  void act(async (value, valid) => {
                    const destination = await save({
                      title: S.saveTitle,
                      defaultPath: value.name,
                    });
                    if (!valid() || !destination) return null;
                    await fileDelivery.copy(value, destination);
                    return S.saved;
                  })
                }
              >
                {S.save}
              </button>
            </>
          )}
          {(shown.phase === "failed" || shown.phase === "paused") && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!active}
              onClick={() => void load()}
            >
              {S.retry}
            </button>
          )}
        </div>
        {(shown.phase !== "ready" || shown.note || shown.pending) && (
          <p role="status">
            {shown.phase === "loading"
              ? S.loading
              : shown.pending
                ? S.pending
                : shown.phase === "paused"
                  ? S.paused
                  : shown.note}
          </p>
        )}
      </div>
      {shown.text !== undefined && (
        <div className="artifact-file-content">
          {markdown ? (
            <div className="artifact-document markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                urlTransform={() => ""}
                components={{
                  a: ({ children }) => <span>{children}</span>,
                  img: ({ alt }) => <span>{alt}</span>,
                }}
              >
                {shown.text}
              </ReactMarkdown>
            </div>
          ) : (
            <pre
              className="a-term"
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {shown.text}
            </pre>
          )}
        </div>
      )}
      {shown.text !== undefined && feedbackOpen && (
        <form
          className="artifact-feedback"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canEditFeedback()) return;
            const key = fileFeedbackKey(feedbackPath, contentId);
            const draft = fileFeedbackDrafts.entries(threadKey)[key];
            if (
              draft?.text.trim() &&
              fileFeedbackDrafts.take(threadKey, key, fileFeedbackText(draft))
            ) {
              setFeedbackAdded(true);
              setFeedbackOpen(false);
            }
          }}
        >
          <textarea
            ref={feedbackInput}
            aria-label={W.feedbackLabel}
            placeholder={W.feedbackPlaceholder}
            rows={2}
            disabled={disabled}
            value={feedback.text}
            onChange={(event) => {
              if (!canEditFeedback()) return;
              fileFeedbackDrafts.update(threadKey, feedbackPath, {
                text: event.target.value,
                selection: null,
                contentId,
                scope: "file",
              });
              setFeedbackAdded(false);
            }}
          />
          <div>
            <span>{S.feedbackHint}</span>
            <button type="submit" disabled={disabled || !feedback.text.trim()}>
              {W.feedbackAdd}
            </button>
          </div>
        </form>
      )}
      {feedbackAdded && <p role="status">{W.feedbackAdded}</p>}
      {shown.text !== undefined && (
        <FileFeedbackDrafts
          threadKey={threadKey}
          path={feedbackPath}
          excludeContentId={contentId}
        />
      )}
    </section>
  );
}
