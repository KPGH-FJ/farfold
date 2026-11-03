import { fileBasename } from "../runtime/file_paths";
import type { AttachmentPdfPreviewTarget } from "../runtime/attachment_search_source";
import { ATTACHMENT_SEARCH_STRINGS } from "../runtime/attachment_search_strings";
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
  MAX_PDF_PAGES,
  VISUAL_PREVIEW_STRINGS as V,
} from "../runtime/visual_preview";
import { TextBlockPreview } from "./TextBlockPreview";
import { SourceTextSelection } from "./SourceTextSelection";
import {
  createTextFeedbackSource,
  type TextFeedbackSource,
} from "../runtime/text_feedback_range";
import type { FileFeedbackAnchor } from "../runtime/file_feedback_anchor";
import {
  officeFeedbackSourceIsValid,
  type OfficeFeedbackSource,
} from "../runtime/office_feedback_target";
import { useFileFeedbackTargets } from "./useFileFeedbackTargets";
import {
  visualAreaFeedbackTarget,
  visualAreaFeedbackTargetMatches,
  type VisualAreaFeedbackSource,
} from "../runtime/visual_feedback_target";
import { pptxFailure } from "../runtime/pptx_strings";
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
import { PptxFilePreview } from "./PptxFilePreview";
import { useFileRevisionMonitor } from "./useFileRevisionMonitor";
import type {
  PreviewReadingPosition,
  PreviewReadingPositionRef,
} from "../runtime/preview_reading_position";
import type { PreviewContentStatus } from "../runtime/preview_capture";
import {
  prepareOfficePreview,
  type PreparedOfficePreview,
} from "../runtime/office_preview_prepare";
import {
  fileFeedbackDrafts,
  fileFeedbackKey,
  useFileFeedback,
  type FileFeedbackDestination,
} from "../runtime/drafts";
import { fileFeedbackText } from "../runtime/feedback_strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { FileFeedbackEditor } from "./FileFeedbackEditor";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { FILE_OPEN_STRINGS as S } from "../runtime/file_open_strings";
import { FILE_DELIVERY_STRINGS as D } from "../runtime/file_delivery_strings";
import {
  validVisualFeedbackLocation,
  type VisualPreviewReadiness,
} from "../runtime/visual_feedback";

export interface OpenedFileViewProps {
  feedbackDestination?: FileFeedbackDestination;
  /** The original conversation owns unsent feedback, including after refresh. */
  threadKey: string;
  /** Exact local file selected by the user; never an inferred artifact body. */
  path: string;
  workingDirectory: string;
  active: boolean;
  /** Changes for an explicit new selection, including the same path in another task. */
  selectionKey?: string;
  /** Caller-owned current-file location, never an opinion or selection. */
  readingPosition?: PreviewReadingPositionRef;
  pdfSearchTarget?: AttachmentPdfPreviewTarget;
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
  pdfSearchTarget?: AttachmentPdfPreviewTarget;
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
function isPresentation(file: VerifiedFile) {
  return /\.pptx$/i.test(file.name);
}
function isOfficePreview(file: VerifiedFile) {
  return isWorkbook(file) || isDocument(file) || isPresentation(file);
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
  return message === D.checkWaitExpired ||
    message === D.checkBusy ||
    message === D.unsupportedText
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
  readingPosition: retainedReadingPosition,
  pdfSearchTarget,
  onOpenHtml,
  headerActions,
  onBack,
  feedbackDestination,
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
  const presentationRefresh = useRef<{
    owner: Operation;
    settled: boolean;
    uncertain: boolean;
  } | null>(null);
  const presentationRefreshing = () =>
    presentationRefresh.current?.owner.identity === identity &&
    !presentationRefresh.current.settled;
  const presentationUncertain = () =>
    presentationRefresh.current?.owner.identity === identity &&
    presentationRefresh.current.uncertain;
  const [view, setView] = useState<View>({ identity, phase: "loading" });
  const latestView = useRef(view);
  latestView.current = view;
  const localReadingPosition = useRef<PreviewReadingPosition | null>(null);
  const readingPosition = retainedReadingPosition ?? localReadingPosition;
  const pendingPdfTarget = useRef({ identity, target: pdfSearchTarget });
  if (pendingPdfTarget.current.identity !== identity)
    pendingPdfTarget.current = { identity, target: pdfSearchTarget };
  const readingOwner = useRef(identity);
  const textContent = useRef<HTMLDivElement>(null);
  const textScroll = useRef(0);
  const [sourceMode, setSourceMode] = useState<string | null>(null);
  if (readingOwner.current !== identity) {
    readingOwner.current = identity;
    readingPosition.current = null;
    textScroll.current = 0;
  }
  const [visualReadiness, setVisualReadiness] =
    useState<VisualPreviewReadiness | null>(null);
  const [officeStatus, setOfficeStatus] = useState<PreviewContentStatus | null>(
    null,
  );
  const latestOfficeStatus = useRef(officeStatus);
  const reportOfficeStatus = (status: PreviewContentStatus) => {
    if (
      mounted.current &&
      currentProps.current.identity === identity &&
      latestView.current.file === status.file
    ) {
      latestOfficeStatus.current = status;
      if (status.state !== "ready" || status.readInFlight)
        targets.clearOffice();
      setOfficeStatus(status);
    }
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
    if (!next) targets.clearVisual();
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
      targets.clear();
      operation.current?.parser?.abort();
      operation.current = null;
      latestReadiness.current = null;
      targets.clearText();
    };
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      targets.clear();
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
      (latestView.current.block && latestBlockStatus.current?.readInFlight) ||
      (latestView.current.file &&
        isPresentation(latestView.current.file) &&
        latestOfficeStatus.current?.file === latestView.current.file &&
        latestOfficeStatus.current.readInFlight)
    )
      return false;
    if (presentationRefreshing() || (valid && presentationUncertain()))
      return false;
    // Only an explicit new read retries an unknown receipt. Visibility and the
    // automatic monitor never make an unfinished read safe to repeat.
    if (!valid && presentationRefresh.current?.owner.identity === identity)
      presentationRefresh.current = null;
    if (blockReadFlight.current?.identity === identity) return false;
    const owner: Operation = {
      identity,
      kind: preserve ? "refresh" : undefined,
      valid,
      parser: preserve ? new AbortController() : undefined,
    };
    operation.current = owner;
    const searchTarget = preserve ? undefined : pendingPdfTarget.current.target;
    pendingPdfTarget.current.target = undefined;
    const readCurrent = () => {
      if (!current(owner)) return false;
      if (searchTarget && !searchTarget.current()) {
        setView({
          identity,
          phase: "paused",
          note: ATTACHMENT_SEARCH_STRINGS.errors.changed,
        });
        return false;
      }
      return true;
    };
    targets.clear();
    let applied = false;
    let blockAttempt = false;
    let inspected: VerifiedFile | undefined;
    if (!preserve) {
      latestReadiness.current = null;
      setVisualReadiness(null);
    }
    const previous = latestView.current;
    if (preserve && previous.file && isPresentation(previous.file))
      presentationRefresh.current = { owner, settled: false, uncertain: false };
    textScroll.current = textContent.current?.scrollTop ?? textScroll.current;
    setView(
      preserve
        ? { ...previous, pending: true }
        : { identity, phase: "loading" },
    );
    try {
      const file =
        verified ?? (await fileDelivery.inspectLink(workingDirectory, path));
      if (!readCurrent()) return false;
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
            if (!readCurrent()) return false;
            if (!sameFile(visual.file, file)) throw new Error("File changed");
            const exactSearch =
              visual.mimeType === "application/pdf" &&
              searchTarget &&
              searchTarget.current() &&
              sameFile(searchTarget.file, file) &&
              Number.isSafeInteger(searchTarget.pageNumber) &&
              searchTarget.pageNumber >= 1 &&
              searchTarget.pageNumber <= MAX_PDF_PAGES;
            if (searchTarget && !exactSearch) readingPosition.current = null;
            setView({
              identity,
              phase: "ready",
              file,
              visual,
              pdfSearchTarget: exactSearch ? searchTarget : undefined,
              note:
                searchTarget && !exactSearch
                  ? ATTACHMENT_SEARCH_STRINGS.errors.changed
                  : undefined,
            });
          } catch (error) {
            if (preserve) throw error;
            if (current(owner))
              setView({ identity, phase: "ready", file, note: V.failed });
          }
        }
      } else if (isOfficePreview(file)) {
        if (preserve) {
          if (
            isPresentation(file) &&
            presentationRefresh.current?.owner !== owner
          )
            presentationRefresh.current = {
              owner,
              settled: false,
              uncertain: false,
            };
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
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      const failureMessage = error instanceof Error ? error.message : error;
      const ownsPresentation =
        presentationRefresh.current?.owner === owner &&
        mounted.current &&
        currentProps.current.identity === identity;
      if (
        ownsPresentation &&
        (code === "readPending" ||
          code === "readBusy" ||
          failureMessage === D.checkWaitExpired ||
          failureMessage === D.checkBusy)
      )
        presentationRefresh.current!.uncertain = true;
      const ownsHiddenBlock =
        blockAttempt &&
        mounted.current &&
        currentProps.current.identity === identity &&
        blockReadFlight.current === owner;
      if (
        current(owner) ||
        ownsHiddenBlock ||
        (ownsPresentation && code !== "cancelled" && !operation.current)
      ) {
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
                  : previous.file && isPresentation(previous.file)
                    ? pptxFailure(error)
                    : previous.note,
              }
            : inspected &&
                isText(inspected) &&
                (inspected.size > MAX_TEXT_BYTES ||
                  failureMessage === D.unsupportedText)
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
      if (presentationRefresh.current?.owner === owner) {
        presentationRefresh.current.settled = true;
        if (!presentationRefresh.current.uncertain)
          presentationRefresh.current = null;
        if (mounted.current && currentProps.current.identity === identity)
          setView((latest) => ({ ...latest }));
      }
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
    Boolean(file && (visualFileKind(file.name) || isOfficePreview(file)));
  const officeReady = () =>
    latestOfficeStatus.current?.file === latestView.current.file &&
    latestOfficeStatus.current?.state === "ready" &&
    !latestOfficeStatus.current.readInFlight;
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
    !latestView.current.pending &&
    (!file || !isOfficePreview(file) || officeReady()) &&
    !(shown.block && latestBlockStatus.current?.readInFlight) &&
    shown.phase === "ready" &&
    (shown.text !== undefined ||
      Boolean(shown.block) ||
      (Boolean(file && isOfficePreview(file)) && officeReady()) ||
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
  const acceptsOfficeSource = (source: OfficeFeedbackSource) => {
    const latest = latestView.current;
    return (
      mounted.current &&
      currentProps.current.active &&
      currentProps.current.identity === identity &&
      latest.identity === identity &&
      latest.phase === "ready" &&
      !latest.pending &&
      !operation.current &&
      officeReady() &&
      Boolean(
        latest.file &&
        ((source.kind === "xlsx" && isWorkbook(latest.file)) ||
          (source.kind === "docx" && isDocument(latest.file)) ||
          (source.kind === "pptx" && isPresentation(latest.file))) &&
        sameFile(latest.file, source.file),
      ) &&
      officeFeedbackSourceIsValid(source)
    );
  };
  const acceptsVisualSource = (source: VisualAreaFeedbackSource) => {
    const latest = latestView.current;
    if (
      !mounted.current ||
      !currentProps.current.active ||
      currentProps.current.identity !== identity ||
      latest.identity !== identity ||
      latest.phase !== "ready" ||
      latest.pending ||
      operation.current ||
      !latest.file ||
      !sameFile(latest.file, source.file) ||
      !latest.visual ||
      latestReadiness.current?.source !== latest.visual ||
      !latestReadiness.current.location
    )
      return false;
    const anchor = visualAreaFeedbackTarget(source);
    if (source.kind === "image-area" && anchor?.kind === "image-area")
      return (
        latestReadiness.current.location.kind === "image" &&
        visualAreaFeedbackTargetMatches({ source, anchor }, latest.visual)
      );
    if (source.kind === "pdf-area" && anchor?.kind === "pdf-area")
      return (
        latestReadiness.current.location.kind === "pdf" &&
        latestReadiness.current.location.page === anchor.page &&
        latestReadiness.current.location.pageCount === anchor.pageCount &&
        visualAreaFeedbackTargetMatches({ source, anchor }, latest.visual)
      );
    return false;
  };
  const applyTarget = (anchor: FileFeedbackAnchor) => {
    const saved = fileFeedbackDrafts.read(threadKey, feedbackPath, contentId);
    const { lineInput: _lineInput, ...retained } = saved;
    fileFeedbackDrafts.update(threadKey, feedbackPath, {
      ...retained,
      contentId,
      scope: "file",
      selection: null,
      anchor,
    });
    setFeedbackAdded(false);
    setFeedbackOpen(true);
    feedbackInput.current?.focus();
  };
  const targets = useFileFeedbackTargets({
    identity,
    canEdit: canEditFeedback,
    acceptsText: acceptsTextSource,
    acceptsOffice: acceptsOfficeSource,
    acceptsVisual: acceptsVisualSource,
    visualPreview: () => latestView.current.visual,
    acceptsEditing: (targetFile) => {
      const latest = latestView.current;
      return (
        latest.file === file &&
        Boolean(file && sameFile(file, targetFile)) &&
        ((Boolean(file && isOfficePreview(file)) &&
          latest.office === shown.office) ||
          (Boolean(shown.visual) &&
            latest.visual === shown.visual &&
            latestReadiness.current?.source === shown.visual &&
            Boolean(latestReadiness.current?.location)))
      );
    },
    apply: applyTarget,
  });
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
        !isOfficePreview(file) ||
        (officeStatus?.file === file && officeStatus.state === "ready")),
    blocked:
      Boolean(shown.pending) ||
      Boolean(presentationRefreshing() || presentationUncertain()) ||
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
      if (feedbackOpen || targets.hasPendingSelection()) return "deferred";
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
                isOfficePreview(file)) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={
                    disabled ||
                    Boolean(presentationRefreshing()) ||
                    Boolean(
                      isPresentation(file) &&
                      officeStatus?.file === file &&
                      officeStatus.readInFlight,
                    )
                  }
                  onClick={() =>
                    void load(
                      undefined,
                      Boolean(shown.block) || isPresentation(file),
                    )
                  }
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
          onTextSelectionAvailability={targets.reportText}
          onTextSelectionConfirm={targets.confirmText}
        />
      )}
      {shown.visual && (
        <VisualFilePreview
          key={`${identity}:${shown.file?.version}`}
          preview={shown.visual}
          active={active}
          onReadiness={reportVisualReadiness}
          interactionBlocked={Boolean(shown.pending)}
          onVisualTargetAvailability={targets.reportVisual}
          onVisualTargetConfirm={targets.confirmVisual}
          onTargetEditing={targets.reportEditing}
          readingPosition={readingPosition}
          initialPdfPage={shown.pdfSearchTarget}
        />
      )}
      {file && shown.phase === "ready" && isWorkbook(file) && (
        <WorkbookFilePreview
          key={`${identity}:${file.version}:${file.sha256}`}
          file={file}
          active={active}
          interactionBlocked={Boolean(shown.pending)}
          readingPosition={readingPosition}
          prepared={
            shown.office?.kind === "workbook" ? shown.office : undefined
          }
          onStatus={reportOfficeStatus}
          onOfficeTargetAvailability={targets.reportOffice}
          onOfficeTargetConfirm={targets.confirmOffice}
          onOfficeTargetEditing={targets.reportEditing}
        />
      )}
      {file && shown.phase === "ready" && isDocument(file) && (
        <DocxFilePreview
          key={`${identity}:${file.version}:${file.sha256}`}
          file={file}
          active={active}
          interactionBlocked={Boolean(shown.pending)}
          readingPosition={readingPosition}
          prepared={shown.office?.kind === "docx" ? shown.office : undefined}
          onStatus={reportOfficeStatus}
          onOfficeTargetAvailability={targets.reportOffice}
          onOfficeTargetConfirm={targets.confirmOffice}
        />
      )}
      {file && shown.phase === "ready" && isPresentation(file) && (
        <PptxFilePreview
          key={`${identity}:${file.version}:${file.sha256}`}
          file={file}
          active={active}
          interactionBlocked={Boolean(shown.pending)}
          readingPosition={readingPosition}
          prepared={shown.office?.kind === "pptx" ? shown.office : undefined}
          onStatus={reportOfficeStatus}
          onOfficeTargetAvailability={targets.reportOffice}
          onOfficeTargetConfirm={targets.confirmOffice}
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
                  targets.clearText();
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
              onAvailability={targets.reportText}
              onConfirm={targets.confirmText}
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
        <FileFeedbackEditor
          feedback={feedback}
          disabled={disabled}
          canEdit={canEditFeedback}
          inputRef={feedbackInput}
          isPdf={Boolean(file && visualFileKind(file.name) === "pdf")}
          pdfPage={visualLocation?.kind === "pdf" ? visualLocation : undefined}
          hasBlock={Boolean(shown.block)}
          onWholeFile={() => {
            if (!canEditFeedback()) return;
            const saved = fileFeedbackDrafts.read(
              threadKey,
              feedbackPath,
              contentId,
            );
            const {
              anchor: _anchor,
              lineInput: _lineInput,
              ...retained
            } = saved;
            fileFeedbackDrafts.update(threadKey, feedbackPath, {
              ...retained,
              contentId,
              scope: "file",
              selection: null,
            });
          }}
          onPdfPage={() => {
            if (
              !canEditFeedback() ||
              latestReadiness.current !== visualReadiness ||
              visualLocation?.kind !== "pdf"
            )
              return;
            const saved = fileFeedbackDrafts.read(
              threadKey,
              feedbackPath,
              contentId,
            );
            fileFeedbackDrafts.update(threadKey, feedbackPath, {
              ...saved,
              contentId,
              scope: "file",
              selection: null,
              anchor: {
                kind: "pdf-page",
                page: visualLocation.page,
                pageCount: visualLocation.pageCount,
              },
            });
          }}
          onTextChange={(text) => {
            if (!canEditFeedback()) return;
            fileFeedbackDrafts.update(threadKey, feedbackPath, {
              ...fileFeedbackDrafts.read(threadKey, feedbackPath, contentId),
              text,
              selection: null,
              contentId,
              scope: "file",
            });
            setFeedbackAdded(false);
          }}
          onSubmit={() => {
            if (!canEditFeedback()) return;
            const key = fileFeedbackKey(feedbackPath, contentId);
            const draft = fileFeedbackDrafts.entries(threadKey)[key];
            if (
              draft?.text.trim() &&
              fileFeedbackDrafts.take(
                threadKey,
                key,
                fileFeedbackText(draft),
                feedbackDestination,
              )
            ) {
              setFeedbackAdded(true);
              setFeedbackOpen(false);
            }
          }}
        />
      )}
      {feedbackAdded && <p role="status">{W.feedbackAdded}</p>}
      {
        <FileFeedbackDrafts
          threadKey={threadKey}
          feedbackDestination={feedbackDestination}
          path={file ? feedbackPath : undefined}
          excludeContentId={supportsFeedback ? contentId : undefined}
        />
      }
    </section>
  );
}
