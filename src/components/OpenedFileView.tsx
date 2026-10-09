import { fileBasename } from "../runtime/file_paths";
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
import {
  fileDelivery,
  type VerifiedFile,
  type VisualPreview,
} from "../runtime/file_delivery";
import {
  visualFileKind,
  VISUAL_PREVIEW_STRINGS as V,
} from "../runtime/visual_preview";
import { TextBlockPreview } from "./TextBlockPreview";
import { SourceTextSelection } from "./SourceTextSelection";
import {
  createTextFeedbackSource,
  textFeedbackRangeMatches,
  type TextFeedbackSource,
} from "../runtime/text_feedback_range";
import type { TextRangeAnchor } from "../runtime/file_feedback_anchor";
import {
  readTextBlock,
  textBlockFailure,
  type TextBlockPreview as TextBlock,
} from "../runtime/text_block_preview";
import { TEXT_BLOCK_STRINGS as T } from "../runtime/text_block_strings";
import { restoredTextBlock } from "../runtime/preview_reading_position";
import { FILE_COPY_STRINGS as C } from "../runtime/file_copy_strings";
import { copyFailureCode } from "../runtime/file_copy_types";
import { fileCopyJobs } from "../runtime/file_copy_jobs";
import { FileCopyJobsStatus } from "./FileCopyJobsStatus";
import { VisualFilePreview } from "./VisualFilePreview";
import { WorkbookFilePreview } from "./WorkbookFilePreview";
import { DocxFilePreview } from "./DocxFilePreview";
import { useFileRevisionMonitor } from "./useFileRevisionMonitor";
import type { PreviewReadingPosition } from "../runtime/preview_reading_position";
import type { PreviewContentStatus } from "../runtime/preview_capture";
import {
  prepareOfficePreview,
  type PreparedOfficePreview,
} from "../runtime/office_preview_prepare";
import {
  fileFeedbackDrafts,
  fileFeedbackKey,
  useFileFeedback,
} from "../runtime/drafts";
import { fileFeedbackText } from "../runtime/feedback_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import { VISUAL_FEEDBACK_STRINGS as F } from "../runtime/visual_feedback_strings";
import {
  validVisualFeedbackLocation,
  type VisualPreviewReadiness,
} from "../runtime/visual_feedback";

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
  textSource?: TextFeedbackSource | null;
  block?: TextBlock;
  visual?: VisualPreview;
  office?: PreparedOfficePreview;
  note?: string;
  pending?: boolean;
};
type Operation = {
  identity: string;
  kind?: "refresh";
  valid?: () => boolean;
  parser?: AbortController;
};
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
function isWorkbook(file: VerifiedFile) {
  return /\.xlsx$/i.test(file.name);
}
function isDocument(file: VerifiedFile) {
  return /\.docx$/i.test(file.name);
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

function openFailureNotice(error: unknown): string {
  // Only the fixed read-check notices are safe to show. Never expose a raw
  // rejection, file path or OS error through this recovery view.
  const message = error instanceof Error ? error.message : error;
  if (error && typeof error === "object" && "code" in error)
    return T.failures[textBlockFailure(error)];
  return message === D.checkWaitExpired || message === D.checkBusy
    ? message
    : S.failed;
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
  const blockReadFlight = useRef<Operation | null>(null);
  const [view, setView] = useState<View>({ identity, phase: "loading" });
  const latestView = useRef(view);
  latestView.current = view;
  const readingPosition = useRef<PreviewReadingPosition | null>(null);
  const readingOwner = useRef(identity);
  const textContent = useRef<HTMLDivElement>(null);
  const textScroll = useRef(0);
  const textSelection = useRef<{
    identity: string;
    source: TextFeedbackSource;
  } | null>(null);
  const [sourceMode, setSourceMode] = useState<string | null>(null);
  if (readingOwner.current !== identity) {
    readingOwner.current = identity;
    readingPosition.current = null;
    textScroll.current = 0;
    textSelection.current = null;
  }
  const [visualReadiness, setVisualReadiness] =
    useState<VisualPreviewReadiness | null>(null);
  const [officeStatus, setOfficeStatus] = useState<PreviewContentStatus | null>(
    null,
  );
  const reportOfficeStatus = (status: PreviewContentStatus) => {
    if (
      mounted.current &&
      currentProps.current.identity === identity &&
      latestView.current.file === status.file
    )
      setOfficeStatus(status);
  };
  const [blockStatus, setBlockStatus] = useState<PreviewContentStatus | null>(
    null,
  );
  const latestBlockStatus = useRef(blockStatus);
  const reportBlockStatus = (status: PreviewContentStatus) => {
    if (
      mounted.current &&
      currentProps.current.identity === identity &&
      latestView.current.file &&
      sameFile(latestView.current.file, status.file)
    ) {
      latestBlockStatus.current = status;
      setBlockStatus(status);
    }
  };
  const latestReadiness = useRef(visualReadiness);
  // Event handlers withdraw eligibility synchronously; a queued render must not
  // let an old page button select the page that has just been left.
  const reportVisualReadiness = (value: VisualPreviewReadiness) => {
    const shown = latestView.current;
    if (
      !mounted.current ||
      !currentProps.current.active ||
      currentProps.current.identity !== identity ||
      shown.identity !== identity ||
      shown.phase !== "ready" ||
      shown.visual !== value.source ||
      !shown.file ||
      !sameFile(shown.file, value.source.file) ||
      (operation.current && operation.current.kind !== "refresh")
    )
      return;
    const next =
      value.location &&
      validVisualFeedbackLocation(value.source, value.location)
        ? value
        : null;
    latestReadiness.current = next;
    setVisualReadiness(next);
  };
  const current = (owner: Operation) =>
    mounted.current &&
    currentProps.current.active &&
    currentProps.current.identity === owner.identity &&
    operation.current === owner &&
    (owner.valid?.() ?? true);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.parser?.abort();
      operation.current = null;
      latestReadiness.current = null;
      textSelection.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      textSelection.current = null;
      const refreshing = operation.current?.kind === "refresh";
      operation.current?.parser?.abort();
      operation.current = null;
      latestReadiness.current = null;
      setVisualReadiness(null);
      setView((previous) =>
        previous.identity === identity &&
        (previous.phase === "loading" || previous.pending)
          ? refreshing && previous.phase === "ready"
            ? { ...previous, pending: false }
            : { identity, phase: "paused" }
          : previous,
      );
    }
  }, [active, identity]);

  async function load(
    verified?: VerifiedFile,
    preserve = false,
    valid?: () => boolean,
  ): Promise<boolean> {
    if (
      !mounted.current ||
      !currentProps.current.active ||
      currentProps.current.identity !== identity ||
      operation.current ||
      (latestView.current.block && latestBlockStatus.current?.readInFlight)
    )
      return false;
    if (blockReadFlight.current?.identity === identity) return false;
    const owner: Operation = {
      identity,
      kind: preserve ? "refresh" : undefined,
      valid,
      parser: preserve ? new AbortController() : undefined,
    };
    operation.current = owner;
    textSelection.current = null;
    let applied = false;
    let blockAttempt = false;
    let inspected: VerifiedFile | undefined;
    if (!preserve) {
      latestReadiness.current = null;
      setVisualReadiness(null);
    }
    const previous = latestView.current;
    textScroll.current = textContent.current?.scrollTop ?? textScroll.current;
    setView(
      preserve
        ? { ...previous, pending: true }
        : { identity, phase: "loading" },
    );
    try {
      const file =
        verified ?? (await fileDelivery.inspectLink(workingDirectory, path));
      if (!current(owner)) return false;
      inspected = file;
      if (isHtml(file)) {
        setView({ identity, phase: "ready", file, note: S.html });
        currentProps.current.onOpenHtml(file);
      } else if (visualFileKind(file.name)) {
        if (
          visualFileKind(file.name) === "image" &&
          file.size > 8 * 1024 * 1024
        ) {
          setView({ identity, phase: "ready", file, note: V.limit });
        } else {
          try {
            const visual = await fileDelivery.readVisual(file);
            if (!current(owner)) return false;
            if (!sameFile(visual.file, file)) throw new Error("File changed");
            setView({ identity, phase: "ready", file, visual });
          } catch (error) {
            if (preserve) throw error;
            if (current(owner))
              setView({ identity, phase: "ready", file, note: V.failed });
          }
        }
      } else if (isWorkbook(file) || isDocument(file)) {
        if (preserve) {
          const office = await prepareOfficePreview(
            file,
            readingPosition,
            owner.parser!.signal,
            () => current(owner),
          );
          if (!current(owner)) return false;
          setView({ identity, phase: "ready", file, office });
        } else setView({ identity, phase: "ready", file });
      } else if (isText(file) && file.size <= MAX_TEXT_BYTES) {
        const preview = await fileDelivery.readText(file);
        if (!current(owner)) return false;
        if (!sameFile(preview.file, file)) throw new Error("File changed");
        setView({
          identity,
          phase: "ready",
          file: preview.file,
          text: preview.text,
          textSource: createTextFeedbackSource(preview, file),
        });
      } else if (isText(file)) {
        blockAttempt = true;
        blockReadFlight.current = owner;
        const block = await readTextBlock(
          file,
          restoredTextBlock(file, readingPosition),
          true,
        );
        if (!current(owner)) return false;
        latestBlockStatus.current = {
          file,
          state: "ready",
          readInFlight: false,
        };
        setBlockStatus(latestBlockStatus.current);
        setView({ identity, phase: "ready", file, block });
      } else {
        setView({
          identity,
          phase: "ready",
          file,
          note: S.other,
        });
      }
      applied = true;
      return true;
    } catch (error) {
      const ownsHiddenBlock =
        blockAttempt &&
        mounted.current &&
        currentProps.current.identity === identity &&
        blockReadFlight.current === owner;
      if (current(owner) || ownsHiddenBlock) {
        if (preserve && previous.block) {
          const status: PreviewContentStatus = {
            file: previous.block.file,
            state: "failed",
            code: textBlockFailure(error),
            readInFlight: false,
          };
          latestBlockStatus.current = status;
          setBlockStatus(status);
        }
        setView(
          preserve
            ? {
                ...previous,
                pending: false,
                note: previous.block
                  ? T.failures[textBlockFailure(error)]
                  : previous.note,
              }
            : inspected && isText(inspected) && inspected.size > MAX_TEXT_BYTES
              ? {
                  identity,
                  phase: "ready",
                  file: inspected,
                  note: openFailureNotice(error),
                }
              : { identity, phase: "failed", note: openFailureNotice(error) },
        );
      }
      if (preserve && valid) {
        const message = error instanceof Error ? error.message : error;
        if (message === D.checkWaitExpired) throw { code: "pending" };
        if (message === D.checkBusy) throw { code: "busy" };
        const code =
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        if (code === "readPending") throw { code: "pending" };
        if (code === "readBusy") throw { code: "busy" };
        if (code === "pending" || code === "busy") throw { code };
      }
      return false;
    } finally {
      if (blockReadFlight.current === owner) {
        blockReadFlight.current = null;
        if (mounted.current && currentProps.current.identity === identity)
          setView((latest) => ({ ...latest }));
      }
      if (operation.current === owner) {
        operation.current = null;
        // Window visibility can invalidate publication without active=false.
        // Restore the old snapshot and release pending controls in that case.
        if (
          preserve &&
          !applied &&
          mounted.current &&
          currentProps.current.identity === identity
        )
          setView((latest) =>
            latest.identity === identity && latest.pending
              ? { ...previous, pending: false }
              : latest,
          );
      }
    }
  }

  useEffect(() => {
    if (currentProps.current.active) void load();
    else setView({ identity, phase: "paused" });
    return () => {
      if (operation.current?.identity === identity) {
        operation.current.parser?.abort();
        operation.current = null;
      }
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

  async function actOnLocation(reveal: boolean) {
    if (
      !mounted.current ||
      !currentProps.current.active ||
      currentProps.current.identity !== identity ||
      view.identity !== identity ||
      view.phase !== "failed" ||
      view.file ||
      operation.current
    )
      return;
    const owner: Operation = { identity };
    operation.current = owner;
    setView({ ...view, pending: true });
    try {
      if (reveal)
        await fileDelivery.revealSelectedLocation(workingDirectory, path);
      else await fileDelivery.openSelectedLocation(workingDirectory, path);
      if (current(owner))
        setView({
          ...view,
          pending: false,
          note: reveal ? T.revealedLocation : T.openedLocation,
        });
    } catch {
      if (current(owner))
        setView({ ...view, pending: false, note: T.locationFailed });
    } finally {
      if (operation.current === owner) operation.current = null;
    }
  }

  const shown =
    view.identity === identity ? view : { identity, phase: "loading" as const };
  const file = shown.file;
  const disabled =
    !active ||
    shown.pending ||
    shown.phase === "loading" ||
    Boolean(shown.block && blockStatus?.readInFlight) ||
    blockReadFlight.current?.identity === identity;
  const name = file?.name || fileBasename(path);
  const markdown = file && /^(md|markdown)$/i.test(extension(file.name));
  const sourceVisible = !markdown || sourceMode === identity;
  const sourceVisibleRef = useRef(sourceVisible);
  sourceVisibleRef.current = sourceVisible;
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
  const visualLocation =
    active && visualReadiness && shown.visual === visualReadiness.source
      ? visualReadiness.location
      : null;
  const supportsFeedback =
    shown.text !== undefined ||
    Boolean(shown.block) ||
    Boolean(file && visualFileKind(file.name));
  const hasRetainedFeedback = () => {
    const saved = fileFeedbackDrafts.read(threadKey, feedbackPath, contentId);
    return Boolean(saved.text || saved.anchor);
  };
  const canEditFeedback = () =>
    mounted.current &&
    currentProps.current.active &&
    currentProps.current.identity === identity &&
    currentFeedback.current === feedbackOwner &&
    !operation.current &&
    !(shown.block && latestBlockStatus.current?.readInFlight) &&
    shown.phase === "ready" &&
    (shown.text !== undefined ||
      Boolean(shown.block) ||
      (latestReadiness.current?.source === shown.visual &&
        Boolean(latestReadiness.current?.location)) ||
      (supportsFeedback && hasRetainedFeedback())) &&
    Boolean(file);
  useEffect(() => {
    setFeedbackOpen(hasRetainedFeedback());
    setFeedbackAdded(false);
  }, [threadKey, identity, feedbackPath, contentId]);
  useEffect(() => {
    if (active && feedbackOpen) feedbackInput.current?.focus();
  }, [active, feedbackOpen]);
  const acceptsTextSource = (source: TextFeedbackSource) => {
    const latest = latestView.current;
    return (
      mounted.current &&
      currentProps.current.active &&
      currentProps.current.identity === identity &&
      latest.identity === identity &&
      latest.phase === "ready" &&
      !latest.pending &&
      !operation.current &&
      Boolean(latest.file && sameFile(latest.file, source.file)) &&
      (latest.block
        ? latestBlockStatus.current?.state === "ready" &&
          !latestBlockStatus.current.readInFlight
        : sourceVisibleRef.current && latest.textSource === source)
    );
  };
  const reportTextSelection = ({
    source,
    available,
  }: {
    source: TextFeedbackSource;
    available: boolean;
  }) => {
    if (!available) {
      if (textSelection.current?.source === source)
        textSelection.current = null;
    } else if (acceptsTextSource(source))
      textSelection.current = { identity, source };
  };
  const confirmTextSelection = ({
    source,
    anchor,
  }: {
    source: TextFeedbackSource;
    anchor: TextRangeAnchor;
  }) => {
    if (
      !canEditFeedback() ||
      !acceptsTextSource(source) ||
      textSelection.current?.identity !== identity ||
      textSelection.current.source !== source ||
      !textFeedbackRangeMatches(source, anchor)
    )
      return;
    const saved = fileFeedbackDrafts.read(threadKey, feedbackPath, contentId);
    const { lineInput: _lineInput, ...value } = saved;
    fileFeedbackDrafts.update(threadKey, feedbackPath, {
      ...value,
      contentId,
      scope: "file",
      selection: null,
      anchor,
    });
    setFeedbackAdded(false);
    setFeedbackOpen(true);
    feedbackInput.current?.focus();
  };
  const revisionNotice = useFileRevisionMonitor({
    identity,
    file: file && !isHtml(file) ? file : undefined,
    active:
      active &&
      shown.phase === "ready" &&
      (!shown.block ||
        Boolean(
          blockStatus?.file &&
          sameFile(blockStatus.file, shown.block.file) &&
          blockStatus.state === "ready",
        )) &&
      (!file ||
        (!isWorkbook(file) && !isDocument(file)) ||
        (officeStatus?.file === file && officeStatus.state === "ready")),
    blocked:
      Boolean(shown.pending) ||
      Boolean(shown.block && blockStatus?.readInFlight) ||
      blockReadFlight.current?.identity === identity,
    apply: async (next, valid) => {
      if (
        !valid() ||
        operation.current ||
        (shown.block && latestBlockStatus.current?.readInFlight)
      )
        return "deferred";
      // Do not replace the text beneath an opinion the user is editing.
      if (feedbackOpen || textSelection.current?.identity === identity)
        return "deferred";
      if (await load(next, true, valid)) return "applied";
      return valid() ? "failed" : "cancelled";
    },
  });
  useLayoutEffect(() => {
    if (textContent.current) textContent.current.scrollTop = textScroll.current;
  }, [shown.text]);
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
              {(isText(file) ||
                shown.text !== undefined ||
                shown.block ||
                visualFileKind(file.name) ||
                isWorkbook(file) ||
                isDocument(file)) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={disabled}
                  onClick={() => void load(undefined, Boolean(shown.block))}
                >
                  {S.refresh}
                </button>
              )}
              {supportsFeedback && (
                <>
                  <button
                    type="button"
                    className="btn btn-text"
                    disabled={disabled || !canEditFeedback()}
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
                      title: T.saveTitle,
                      defaultPath: value.name,
                    });
                    if (!valid() || !destination) return null;
                    try {
                      await fileCopyJobs.begin(value, destination);
                    } catch (error) {
                      return C.failures[
                        copyFailureCode(error) ?? "unavailable"
                      ];
                    }
                    return null;
                  })
                }
              >
                {T.save}
              </button>
            </>
          )}
          {shown.phase === "failed" && !file && (
            <>
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                onClick={() => void actOnLocation(false)}
              >
                {T.openLocation}
              </button>
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                onClick={() => void actOnLocation(true)}
              >
                {T.revealLocation}
              </button>
            </>
          )}
          {(shown.phase === "failed" || shown.phase === "paused") && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                !active || blockReadFlight.current?.identity === identity
              }
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
      {shown.phase === "failed" && !file && (
        <p className="artifact-provenance">{T.locationScope}</p>
      )}
      {revisionNotice && (
        <p className="artifact-provenance" role="status">
          {S.revisionNotices[revisionNotice]}
        </p>
      )}
      {file && <FileCopyJobsStatus file={file} />}
      {shown.block && (
        <TextBlockPreview
          key={`${identity}:${shown.block.file.version}:${shown.block.file.sha256}`}
          initial={shown.block}
          active={active && !shown.pending}
          readingPosition={readingPosition}
          onStatus={reportBlockStatus}
          onTextSelectionAvailability={reportTextSelection}
          onTextSelectionConfirm={confirmTextSelection}
        />
      )}
      {shown.visual && (
        <VisualFilePreview
          key={`${identity}:${shown.file?.version}`}
          preview={shown.visual}
          active={active}
          onReadiness={reportVisualReadiness}
          readingPosition={readingPosition}
        />
      )}
      {file && shown.phase === "ready" && isWorkbook(file) && (
        <WorkbookFilePreview
          key={`${identity}:${file.version}:${file.sha256}`}
          file={file}
          active={active}
          readingPosition={readingPosition}
          prepared={
            shown.office?.kind === "workbook" ? shown.office : undefined
          }
          onStatus={reportOfficeStatus}
        />
      )}
      {file && shown.phase === "ready" && isDocument(file) && (
        <DocxFilePreview
          key={`${identity}:${file.version}:${file.sha256}`}
          file={file}
          active={active}
          readingPosition={readingPosition}
          prepared={shown.office?.kind === "docx" ? shown.office : undefined}
          onStatus={reportOfficeStatus}
        />
      )}
      {shown.text !== undefined && (
        <div
          className="artifact-file-content"
          ref={textContent}
          onScroll={(event) => {
            textScroll.current = event.currentTarget.scrollTop;
          }}
        >
          {markdown && (
            <div className="ac-actions">
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                aria-pressed={!sourceVisible}
                onClick={() => {
                  textSelection.current = null;
                  sourceVisibleRef.current = false;
                  setSourceMode(null);
                }}
              >
                {S.markdownRendered}
              </button>
              <button
                type="button"
                className="btn btn-text"
                disabled={disabled}
                aria-pressed={sourceVisible}
                onClick={() => setSourceMode(identity)}
              >
                {S.markdownSource}
              </button>
            </div>
          )}
          {markdown && !sourceVisible ? (
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
          ) : shown.textSource ? (
            <SourceTextSelection
              source={shown.textSource}
              enabled={!disabled && shown.phase === "ready"}
              className="a-term"
              onAvailability={reportTextSelection}
              onConfirm={confirmTextSelection}
            />
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
      {supportsFeedback && feedbackOpen && (
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
          {file && visualFileKind(file.name) && (
            <div>
              <p role="status">
                {feedback.anchor?.kind === "pdf-page"
                  ? F.pageTarget(
                      feedback.anchor.page,
                      feedback.anchor.pageCount,
                    )
                  : F.fileTarget}
              </p>
              {visualFileKind(file.name) === "pdf" && (
                <div className="ac-actions" style={{ flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn btn-text"
                    disabled={!canEditFeedback()}
                    aria-pressed={!feedback.anchor}
                    onClick={() => {
                      if (!canEditFeedback()) return;
                      const saved = fileFeedbackDrafts.read(
                        threadKey,
                        feedbackPath,
                        contentId,
                      );
                      const { anchor: _anchor, ...value } = saved;
                      fileFeedbackDrafts.update(threadKey, feedbackPath, {
                        ...value,
                        selection: null,
                        contentId,
                        scope: "file",
                      });
                    }}
                  >
                    {F.wholeFile}
                  </button>
                  {visualLocation?.kind === "pdf" && (
                    <button
                      type="button"
                      className="btn btn-text"
                      disabled={!canEditFeedback()}
                      aria-pressed={
                        feedback.anchor?.kind === "pdf-page" &&
                        feedback.anchor.page === visualLocation.page &&
                        feedback.anchor.pageCount === visualLocation.pageCount
                      }
                      onClick={() => {
                        if (
                          !canEditFeedback() ||
                          latestReadiness.current !== visualReadiness
                        )
                          return;
                        const saved = fileFeedbackDrafts.read(
                          threadKey,
                          feedbackPath,
                          contentId,
                        );
                        fileFeedbackDrafts.update(threadKey, feedbackPath, {
                          ...saved,
                          selection: null,
                          contentId,
                          scope: "file",
                          anchor: {
                            kind: "pdf-page",
                            page: visualLocation.page,
                            pageCount: visualLocation.pageCount,
                          },
                        });
                      }}
                    >
                      {F.currentPage(visualLocation.page)}
                    </button>
                  )}
                </div>
              )}
              {feedback.anchor && <p>{F.retained}</p>}
            </div>
          )}
          {(shown.text !== undefined || shown.block) && (
            <div>
              <p role="status">
                {feedback.anchor?.kind === "text-range"
                  ? S.textTarget(
                      feedback.anchor.startLine,
                      feedback.anchor.endLine,
                    )
                  : F.fileTarget}
              </p>
              {feedback.anchor?.kind === "text-range" && (
                <>
                  <p>{S.textTargetRetained}</p>
                  <button
                    type="button"
                    className="btn btn-text"
                    disabled={disabled || !canEditFeedback()}
                    onClick={() => {
                      if (!canEditFeedback()) return;
                      const saved = fileFeedbackDrafts.read(
                        threadKey,
                        feedbackPath,
                        contentId,
                      );
                      const {
                        anchor: _anchor,
                        lineInput: _lineInput,
                        ...value
                      } = saved;
                      fileFeedbackDrafts.update(threadKey, feedbackPath, {
                        ...value,
                        contentId,
                        scope: "file",
                        selection: null,
                      });
                    }}
                  >
                    {F.wholeFile}
                  </button>
                </>
              )}
              {shown.block && !feedback.anchor && <p>{T.feedback}</p>}
            </div>
          )}
          <textarea
            ref={feedbackInput}
            aria-label={W.feedbackLabel}
            placeholder={W.feedbackPlaceholder}
            rows={2}
            disabled={disabled || !canEditFeedback()}
            value={feedback.text}
            onChange={(event) => {
              if (!canEditFeedback()) return;
              fileFeedbackDrafts.update(threadKey, feedbackPath, {
                ...fileFeedbackDrafts.read(threadKey, feedbackPath, contentId),
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
            <button
              type="submit"
              disabled={disabled || !canEditFeedback() || !feedback.text.trim()}
            >
              {W.feedbackAdd}
            </button>
          </div>
        </form>
      )}
      {feedbackAdded && <p role="status">{W.feedbackAdded}</p>}
      {
        <FileFeedbackDrafts
          threadKey={threadKey}
          path={file ? feedbackPath : undefined}
          excludeContentId={supportsFeedback ? contentId : undefined}
        />
      }
    </section>
  );
}
