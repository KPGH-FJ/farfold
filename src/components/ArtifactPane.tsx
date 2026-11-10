import { OpenedFileView } from "./OpenedFileView";
import { FilePreviewPicker } from "./FilePreviewPicker";
import { ReportedFilesList } from "./ReportedFilesList";
import { useContentOwner } from "./useContentOwner";
import {
  isReportedArtifactCurrent,
  reportedArtifactFiles,
  type ReportedArtifactFile,
  type ReportedArtifactOrigin,
} from "../runtime/reported_artifacts";
import type { VerifiedFile } from "../runtime/file_delivery";
import type { AttachmentPdfPreviewTarget } from "../runtime/attachment_search_source";
import type { FileFeedbackDestination } from "../runtime/drafts";
import type { PreviewReadingPositionRef } from "../runtime/preview_reading_position";
import { BrowserWorkspace } from "./BrowserWorkspace";
import {
  browserWorkspaceClient,
  rememberedBrowserPagesClient,
} from "../runtime/browser_surface";
import type { RememberedBrowserOwner } from "../runtime/browser_remembered";
import { BROWSER_WORKSPACE_STRINGS as B } from "../runtime/browser_workspace_strings";
/**
 * 产物抽屉：右侧可拖宽面板，列出会话产物 ——
 * diff 卡（tool_call diff 内容：旧文本行为删除、新文本行为新增）与
 * 命令卡（execute 调用的输出尾部等宽文本）。数据全部来自 thread
 * items（见 paneCards）。
 */
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import type { BrowserWorkspaceState } from "../runtime/browser_workspace";
import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CopyIcon,
  FileTextIcon,
  TerminalWindowIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react";
import {
  artifactFileChoices,
  artifactPaneCards,
  selectedArtifactFile,
} from "../runtime/artifact_view";
import { FileArtifactView } from "./FileArtifactView";
import { threads, type PaneCard, type ThreadState } from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { ARTIFACT_OUTPUT as O } from "../runtime/artifact_output_strings";

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 510;
/** 命令卡渲染的输出尾部行数。 */
const TERMINAL_LINE_CAP = 200;

function CommandCard({
  card,
}: {
  card: Extract<PaneCard, { kind: "command" | "log" }>;
}) {
  const all = card.output ? card.output.split("\n") : [];
  const clipped = all.length > TERMINAL_LINE_CAP;
  const shown = clipped ? all.slice(-TERMINAL_LINE_CAP) : all;
  const truncated = clipped || card.outputTruncated;
  const statusLabel =
    card.status === "failed"
      ? STRINGS.artifacts.failedLog
      : card.status === "pending"
        ? W.stepsPending
        : card.status === "in_progress"
          ? W.stepsRunning
          : card.status !== "completed"
            ? STRINGS.thread.toolResultUnknown
            : card.kind === "log"
              ? STRINGS.artifacts.log
              : null;
  return (
    <div className="a-card">
      <div className="a-card-h">
        <span className="a-path">{card.title}</span>
        {statusLabel && <span className="a-sub">{statusLabel}</span>}
      </div>
      {truncated && (
        <div className="a-note">{STRINGS.artifacts.terminalTruncated}</div>
      )}
      {card.outputIncomplete && <div className="a-note">{O.incomplete}</div>}
      {all.length > 0 && <pre className="a-term">{shown.join("\n")}</pre>}
    </div>
  );
}

export interface OpenedFileRequest {
  taskKey: string;
  cwd: string;
  path: string;
  expectedFile?: VerifiedFile;
  selection: number;
  pdfSearchTarget?: AttachmentPdfPreviewTarget;
}

export function ArtifactPane({
  thread,
  active = true,
  open = true,
  contentMode: requestedMode,
  onContentModeChange,
  onBrowserStateChange,
  onBrowserOwnersChange,
  browserToolbar,
  fileRequest,
  returnFocusRef,
  rememberedBrowserOwner = null,
  feedbackDestination,
}: {
  feedbackDestination?: FileFeedbackDestination;
  rememberedBrowserOwner?: RememberedBrowserOwner | null;
  thread: ThreadState;
  active?: boolean;
  open?: boolean;
  contentMode?: "files" | "browser";
  onContentModeChange?: (mode: "files" | "browser") => void;
  onBrowserStateChange?: (state: BrowserWorkspaceState | null) => void;
  onBrowserOwnersChange?: (ownsPages: boolean) => void;
  browserToolbar?: ReactNode;
  fileRequest?: OpenedFileRequest | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [localMode, setLocalMode] = useState<"files" | "browser">("files");
  const contentMode = requestedMode ?? localMode;
  const [nativeVisible, setNativeVisible] = useState(false);
  const [openedFile, setOpenedFile] = useState<
    (OpenedFileRequest & { scope: string | null }) | null
  >(null);
  const fileSelection = useRef(0);
  const [htmlRequest, setHtmlRequest] = useState<{
    taskKey: string;
    file: VerifiedFile;
  } | null>(null);
  useEffect(() => {
    if (!active || !open || htmlRequest?.taskKey !== thread.key)
      setHtmlRequest(null);
  }, [active, open, thread.key]);
  const roundId = thread.artifactPaneTarget?.roundId ?? null;
  const displayed = open || nativeVisible;
  const showingBrowser = contentMode === "browser" || nativeVisible;
  const ownsContent = useContentOwner(
    thread,
    active && open && !showingBrowser,
    roundId,
  );
  // A selected file also owns navigation within the same conversation/scope.
  // Retire synchronously on explicit actions and on incoming request changes;
  // returning to the same file must not revive an earlier dialog or receipt.
  const pickerIdentity = JSON.stringify([
    fileRequest?.taskKey,
    fileRequest?.cwd,
    fileRequest?.path,
    fileRequest?.selection,
    openedFile,
    thread.artifactPaneTarget?.selected ?? thread.artifactPaneSelection,
  ]);
  const pickerOwner = useRef({ identity: pickerIdentity, token: {} });
  if (pickerOwner.current.identity !== pickerIdentity)
    pickerOwner.current = { identity: pickerIdentity, token: {} };
  const pickerToken = pickerOwner.current.token;
  const ownsPicker = () =>
    ownsContent() && pickerOwner.current.token === pickerToken;
  const contentFeedbackDestination = feedbackDestination && {
    ...feedbackDestination,
    isCurrent: () => ownsPicker() && feedbackDestination.isCurrent(),
  };
  const retirePicker = () => {
    pickerOwner.current = { identity: pickerOwner.current.identity, token: {} };
  };
  useEffect(() => {
    if (roundId !== null) {
      setOpenedFile(null);
      setLocalMode("files");
      onContentModeChange?.("files");
    }
  }, [thread.key, thread.cwd, roundId]);
  const chooseContent = (mode: "files" | "browser") => {
    if (mode !== contentMode) retirePicker();
    setLocalMode(mode);
    onContentModeChange?.(mode);
  };
  useEffect(() => {
    if (
      !fileRequest ||
      fileRequest.taskKey !== thread.key ||
      fileRequest.cwd !== thread.cwd ||
      !active ||
      !open
    )
      return;
    setOpenedFile({ ...fileRequest, cwd: thread.cwd, scope: roundId });
    chooseContent("files");
  }, [fileRequest, thread.key]);
  const openFile = (path: string, expectedFile?: VerifiedFile) => {
    if (!ownsContent()) return;
    retirePicker();
    setOpenedFile({
      taskKey: thread.key,
      cwd: thread.cwd,
      scope: roundId,
      path,
      expectedFile,
      selection: --fileSelection.current,
    });
    chooseContent("files");
  };
  const openReportedFile = (entry: ReportedArtifactFile) => {
    if (!ownsContent() || !isReportedArtifactCurrent(thread, roundId, entry))
      return;
    openFile(entry.path);
  };
  const openReportedSource = (
    entry: ReportedArtifactFile,
    origin: ReportedArtifactOrigin,
  ) => {
    if (
      !ownsContent() ||
      !entry.origins.includes(origin) ||
      !isReportedArtifactCurrent(thread, roundId, entry)
    )
      return;
    retirePicker();
    threads.openArtifactPane(
      thread.key,
      origin.toolItemId,
      `file:${entry.path}`,
    );
  };
  const currentFile =
    openedFile?.taskKey === thread.key &&
    openedFile.cwd === thread.cwd &&
    openedFile.scope === roundId
      ? openedFile
      : null;
  // One transient entry, not a per-file cache. Selection IDs still remount the
  // reader; only the same request path within this thread/directory keeps location.
  const reading = useRef<{
    threadKey: string;
    cwd: string;
    path: string | null;
    position: PreviewReadingPositionRef;
  } | null>(null);
  if (
    !reading.current ||
    reading.current.threadKey !== thread.key ||
    reading.current.cwd !== thread.cwd ||
    (currentFile && reading.current.path !== currentFile.path)
  )
    reading.current = {
      threadKey: thread.key,
      cwd: thread.cwd,
      path: currentFile?.path ?? null,
      position: { current: null },
    };
  // Replace the object, rather than clearing an old object's current value:
  // a late write from an old mount can then touch only its own retired entry.
  const readingPosition = reading.current.position;
  const openHtml = (file: VerifiedFile) => {
    if (!ownsContent()) return;
    setHtmlRequest({ taskKey: thread.key, file });
    chooseContent("browser");
  };
  const closeContent = () => {
    retirePicker();
    threads.closeArtifactPane(thread.key);
  };
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!active || !displayed) return;
    const pane = paneRef.current;
    if (!pane) return;
    const main = pane
      .closest(".conversation-workspace")
      ?.querySelector<HTMLElement>(".thread-main");
    const media = window.matchMedia("(max-width: 1100px)");
    let previous =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement &&
      !pane.contains(document.activeElement)
        ? document.activeElement
        : null;
    const originalInert = main?.inert ?? false;
    const update = () => {
      if (media.matches || (expanded && showingBrowser)) {
        const focused = document.activeElement;
        // At the overlay breakpoint, the covered composer and approval controls
        // must leave both pointer and keyboard navigation until content closes.
        if (focused instanceof HTMLElement && main?.contains(focused))
          previous = focused;
        if (main) main.inert = true;
        if (
          main?.contains(focused) ||
          focused === document.body ||
          focused === document.documentElement
        )
          closeRef.current?.focus();
      } else if (main) main.inert = originalInert;
    };
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      if (main) main.inert = originalInert;
      const target = returnFocusRef?.current ?? previous;
      const restoreFocus = () => {
        const focused = document.activeElement;
        if (
          (!focused ||
            pane.contains(focused) ||
            focused === document.body ||
            focused === document.documentElement) &&
          target?.isConnected &&
          !pane.contains(target) &&
          !target.closest("[hidden], [inert]") &&
          target.getClientRects().length > 0
        )
          target.focus({ preventScroll: true });
      };
      if (pane.hidden && (media.matches || (expanded && showingBrowser))) {
        // Let WebKit finish hiding the pane and release its covered controls.
        requestAnimationFrame(() => {
          if (pane.hidden && !document.querySelector("dialog[open]"))
            restoreFocus();
        });
      } else restoreFocus();
    };
  }, [thread.key, active, displayed, expanded, showingBrowser, returnFocusRef]);
  useEffect(() => {
    if (!active || !displayed) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        document.querySelector(
          ".workspace-control-panel, .mp-panel, [aria-modal=true], dialog[open]",
        )
      )
        return;
      if (
        event.key === "Escape" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        closeContent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [thread.key, active, displayed]);
  const resize = (next: number) =>
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));

  const outputScope = JSON.stringify([thread.key, roundId]);
  const [outputFilter, setOutputFilter] = useState({ scope: "", value: "all" });
  const filter =
    outputFilter.scope === outputScope ? outputFilter.value : "all";
  const scope = thread.items.find((item) => item.id === roundId);
  const stepTarget = scope?.kind === "tool";
  const containingRound = stepTarget
    ? thread.items.find(
        (item) =>
          item.kind === "settled" &&
          item.artifactToolItemIds?.includes(roundId!),
      )
    : undefined;
  const scopedCards = artifactPaneCards(thread, roundId);
  const cards = scopedCards ?? [];
  const reportedFiles = reportedArtifactFiles(thread, roundId);
  const files = artifactFileChoices(cards, scope);
  const outputs = cards.filter((card) => card.kind !== "diff");
  const visibleOutputs = outputs.filter(
    (card) =>
      filter === "all" ||
      card.kind === filter ||
      (filter === "failed" && card.failed),
  );
  const outputText = visibleOutputs
    .filter((card) => card.output)
    .map((card) => [card.title, card.output].filter(Boolean).join("\n"))
    .join("\n\n");
  const copyKey = JSON.stringify([thread.key, roundId, filter, outputText]);
  const copyRequest = useRef(0);
  const [outputCopy, setOutputCopy] = useState<{
    key: string;
    ok: boolean;
  } | null>(null);
  useEffect(() => {
    setOutputCopy(null);
    return () => {
      copyRequest.current += 1;
    };
  }, [copyKey]);
  const copyOutput = async () => {
    if (!outputText) return;
    const request = ++copyRequest.current;
    try {
      await navigator.clipboard.writeText(outputText);
      if (request === copyRequest.current)
        setOutputCopy({ key: copyKey, ok: true });
    } catch {
      if (request === copyRequest.current)
        setOutputCopy({ key: copyKey, ok: false });
    }
  };
  const selected = thread.artifactPaneTarget
    ? thread.artifactPaneTarget.selected
    : thread.artifactPaneSelection;
  const choice = selectedArtifactFile(files, selected, stepTarget);
  const file = choice?.card;
  const missingFile =
    stepTarget && selected !== null && selected !== "output" && !file;
  const value = choice?.key ?? (missingFile ? "" : "output");
  const fileSelector = (
    <label
      className="artifact-file-picker"
      title={
        file
          ? `${file.path}\n${stepTarget ? W.chooseStepContent : roundId ? W.chooseRoundLatest : W.chooseLatest}`
          : W.outputChoice
      }
    >
      {file ? <FileTextIcon size={14} /> : <TerminalWindowIcon size={14} />}
      <select
        aria-label={W.fileChoice}
        value={value}
        onChange={(event) => {
          retirePicker();
          threads.selectArtifact(thread.key, event.target.value, roundId);
        }}
      >
        {missingFile && (
          <option value="" disabled>
            {W.stepFileUnavailable}
          </option>
        )}
        {files.map(({ key, card }) => (
          <option key={key} value={key}>
            {card.path.startsWith(`${thread.cwd}/`)
              ? card.path.slice(thread.cwd.length + 1)
              : card.path}
            {card.fragment && ` · ${W.reportFragment(card.fragment.number)}`}
          </option>
        ))}
        {outputs.length > 0 && <option value="output">{W.outputChoice}</option>}
      </select>
      <CaretDownIcon
        className="artifact-select-caret"
        size={11}
        aria-hidden="true"
      />
    </label>
  );
  const headerActions = (
    <div className="a-actions">
      {contentMode === "files" && !file && !currentFile && (
        <button
          type="button"
          className="a-expand"
          aria-label={W.copyOutput}
          title={W.copyOutput}
          disabled={!outputText}
          onClick={copyOutput}
        >
          <CopyIcon size={17} />
        </button>
      )}
      <button
        type="button"
        className="a-expand"
        aria-label={expanded ? W.restoreContent : W.expandContent}
        title={expanded ? W.restoreContent : W.expandContent}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ArrowsInSimpleIcon size={17} />
        ) : (
          <ArrowsOutSimpleIcon size={17} />
        )}
      </button>
      <button
        ref={closeRef}
        type="button"
        className="a-close"
        aria-label={W.hideContent}
        title={W.hideContent}
        onClick={closeContent}
      >
        <SidebarSimpleIcon size={17} />
      </button>
    </div>
  );
  const reportedList =
    scopedCards === null ? null : (
      <ReportedFilesList
        thread={thread}
        scopeId={roundId}
        active={active && open && !showingBrowser}
        onOpenFile={openReportedFile}
        onOpenSource={openReportedSource}
      />
    );
  const roundScope = roundId ? (
    <div className="artifact-round-scope">
      <span>{stepTarget ? W.stepContent : W.roundContent}</span>
      {containingRound && (
        <button
          type="button"
          onClick={() => {
            if (ownsContent())
              threads.openArtifactPane(thread.key, containingRound.id);
          }}
        >
          {W.showRoundContent}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          if (ownsContent()) threads.openArtifactPane(thread.key);
        }}
      >
        {W.allArtifacts}
      </button>
    </div>
  ) : null;

  return (
    <aside
      ref={paneRef}
      hidden={!displayed}
      className={`artifact-pane${expanded ? " expanded" : ""}${expanded && showingBrowser ? " browser-full" : ""}`}
      style={{ width: expanded ? "72%" : width }}
      aria-label={W.contentLabel}
    >
      <div
        className="a-drag"
        role="separator"
        aria-orientation="vertical"
        aria-label={W.resizeContent}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            setExpanded(false);
            resize(width + (event.key === "ArrowLeft" ? 24 : -24));
          }
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          setExpanded(false);
          drag.current = { startX: event.clientX, startWidth: width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current)
            resize(
              drag.current.startWidth + drag.current.startX - event.clientX,
            );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      <div
        className="artifact-content-tabs"
        role="group"
        aria-label={W.contentLabel}
      >
        <button
          type="button"
          aria-pressed={contentMode === "files"}
          onClick={() => chooseContent("files")}
        >
          {B.filesTab}
        </button>
        <button
          type="button"
          aria-pressed={contentMode === "browser"}
          onClick={() => chooseContent("browser")}
        >
          {B.title}
        </button>
        {contentMode === "browser" && headerActions}
      </div>
      <div hidden={showingBrowser}>
        <FilePreviewPicker
          workingDirectory={thread.cwd}
          active={active && open && !showingBrowser}
          isCurrent={ownsPicker}
          onOpenFile={(file) => {
            if (ownsPicker()) openFile(file.resolvedPath);
          }}
        />
      </div>
      <div className="artifact-browser-body" hidden={!showingBrowser}>
        <BrowserWorkspace
          taskKey={thread.key}
          projectDirectory={thread.cwd}
          active={active}
          client={browserWorkspaceClient}
          rememberedClient={rememberedBrowserPagesClient}
          rememberedOwner={rememberedBrowserOwner}
          visible={active && open && contentMode === "browser"}
          onVisibilityChange={setNativeVisible}
          onStateChange={onBrowserStateChange}
          onOwnersChange={onBrowserOwnersChange}
          toolbar={browserToolbar}
          htmlRequest={htmlRequest?.taskKey === thread.key ? htmlRequest : null}
          onHtmlRequestConsumed={() => setHtmlRequest(null)}
        />
      </div>
      {currentFile && (
        <div className="artifact-opened-file-body" hidden={showingBrowser}>
          <OpenedFileView
            feedbackDestination={contentFeedbackDestination}
            key={`${currentFile.taskKey}:${currentFile.selection}`}
            path={currentFile.path}
            expectedFile={currentFile.expectedFile}
            threadKey={thread.key}
            workingDirectory={thread.cwd}
            readingPosition={readingPosition}
            pdfSearchTarget={currentFile.pdfSearchTarget}
            active={active && open && !showingBrowser}
            onOpenHtml={openHtml}
            headerActions={headerActions}
            onBack={() => {
              retirePicker();
              setOpenedFile(null);
            }}
          />
        </div>
      )}
      {!showingBrowser &&
        !currentFile &&
        (file ? (
          <FileArtifactView
            feedbackDestination={contentFeedbackDestination}
            key={`${thread.key}:${roundId ?? "all"}:${value}`}
            card={file}
            threadKey={thread.key}
            workingDirectory={thread.cwd}
            onOpenHtml={openHtml}
            onOpenFile={openFile}
            active={active && open}
            headerActions={headerActions}
            headerSupplement={
              <>
                {roundScope}
                {reportedList}
              </>
            }
            fileSelector={fileSelector}
          />
        ) : (
          <>
            <div className="a-head">
              <span className="a-title">
                {outputs.length ? W.outputChoice : W.content}
              </span>
              {headerActions}
            </div>
            {outputCopy?.key === copyKey && (
              <p className="a-note" role={outputCopy.ok ? "status" : "alert"}>
                {outputCopy.ok ? W.copied : W.copyFailed}
              </p>
            )}
            {roundScope}
            {reportedList}
            {cards.length > 0 && (
              <div className="artifact-view-toolbar">
                {fileSelector}
                <label className="artifact-output-filter">
                  <select
                    aria-label={O.filter}
                    value={filter}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (["all", "command", "log", "failed"].includes(value))
                        setOutputFilter({ scope: outputScope, value });
                    }}
                  >
                    <option value="all">{O.all}</option>
                    <option value="command">{O.command}</option>
                    <option value="log">{O.log}</option>
                    <option value="failed">{O.failed}</option>
                  </select>
                  <CaretDownIcon size={11} aria-hidden="true" />
                </label>
              </div>
            )}
            <div className="a-list">
              {(scopedCards === null ||
                (cards.length === 0 && reportedFiles?.length === 0)) && (
                <div className="a-empty">
                  {scopedCards === null
                    ? W.roundArtifactsUnavailable
                    : STRINGS.artifacts.empty}
                </div>
              )}
              {missingFile ? (
                <div className="a-empty" role="status">
                  {W.stepFileUnavailable}
                </div>
              ) : (
                cards.length > 0 &&
                visibleOutputs.length === 0 && (
                  <div className="a-empty" role="status">
                    {O.empty}
                  </div>
                )
              )}
              {visibleOutputs.map((card, index) => (
                <CommandCard key={index} card={card} />
              ))}
            </div>
          </>
        ))}
    </aside>
  );
}
