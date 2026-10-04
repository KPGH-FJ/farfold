import { BrowserWorkspace } from "./BrowserWorkspace";
import {
  browserSurfaceGuard,
  browserWorkspaceClient,
} from "../runtime/browser_surface";
import { BROWSER_WORKSPACE_STRINGS as B } from "../runtime/browser_workspace_strings";
/**
 * 产物抽屉：右侧可拖宽面板，列出会话产物 ——
 * diff 卡（tool_call diff 内容：旧文本行为删除、新文本行为新增）与
 * 命令卡（execute 调用的输出尾部等宽文本）。数据全部来自 thread
 * items（见 paneCards）。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CopyIcon,
  FileTextIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { COMMAND_OUTPUT_CAP } from "../runtime/artifacts";
import {
  artifactFiles,
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
  const truncated = clipped || card.output.length >= COMMAND_OUTPUT_CAP;
  return (
    <div className="a-card">
      <div className="a-card-h">
        <span className="a-path">{card.title}</span>
        {(card.kind === "log" || card.failed) && (
          <span className="a-sub">
            {card.failed ? STRINGS.artifacts.failedLog : STRINGS.artifacts.log}
          </span>
        )}
      </div>
      {truncated && (
        <div className="a-note">{STRINGS.artifacts.terminalTruncated}</div>
      )}
      {all.length > 0 && <pre className="a-term">{shown.join("\n")}</pre>}
    </div>
  );
}

export function ArtifactPane({
  thread,
  active = true,
  returnFocusRef,
}: {
  thread: ThreadState;
  active?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [contentMode, setContentMode] = useState<"files" | "browser">("files");
  useEffect(() => {
    setContentMode("files");
  }, [thread.key, thread.artifactPaneTarget]);
  const chooseContent = (mode: "files" | "browser") =>
    browserSurfaceGuard.runLatest(() => setContentMode(mode));
  const closeContent = () =>
    browserSurfaceGuard.runLatest(() => threads.closeArtifactPane(thread.key));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!active) return;
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
      if (media.matches) {
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
      if (
        (pane.contains(document.activeElement) ||
          document.activeElement === document.body ||
          document.activeElement === document.documentElement) &&
        target?.isConnected &&
        !pane.contains(target) &&
        !target.closest("[hidden], [inert]") &&
        target.getClientRects().length > 0
      )
        target.focus();
    };
  }, [thread.key, active, returnFocusRef]);
  useEffect(() => {
    if (!active) return;
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
  }, [thread.key, active]);
  const resize = (next: number) =>
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));

  const roundId = thread.artifactPaneTarget?.roundId ?? null;
  const outputScope = JSON.stringify([thread.key, roundId]);
  const [outputFilter, setOutputFilter] = useState({ scope: "", value: "all" });
  const filter =
    outputFilter.scope === outputScope ? outputFilter.value : "all";
  const stepTarget =
    thread.items.find((item) => item.id === roundId)?.kind === "tool";
  const containingRound = stepTarget
    ? thread.items.find(
        (item) =>
          item.kind === "settled" &&
          item.artifactToolItemIds?.includes(roundId!),
      )
    : undefined;
  const scopedCards = artifactPaneCards(thread, roundId);
  const cards = scopedCards ?? [];
  const files = artifactFiles(cards);
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
  const file = selectedArtifactFile(files, selected);
  const value = file ? `file:${file.path}` : "output";
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
        onChange={(event) =>
          threads.selectArtifact(thread.key, event.target.value, roundId)
        }
      >
        {files.map((card) => (
          <option key={card.path} value={`file:${card.path}`}>
            {card.path.startsWith(`${thread.cwd}/`)
              ? card.path.slice(thread.cwd.length + 1)
              : card.path}
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
      {contentMode === "files" && !file && (
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
        aria-label={STRINGS.artifacts.close}
        title={STRINGS.artifacts.close}
        onClick={closeContent}
      >
        <XIcon size={17} />
      </button>
    </div>
  );
  const roundScope = roundId ? (
    <div className="artifact-round-scope">
      <span>{stepTarget ? W.stepContent : W.roundContent}</span>
      {containingRound && (
        <button
          type="button"
          onClick={() =>
            threads.openArtifactPane(thread.key, containingRound.id)
          }
        >
          {W.showRoundContent}
        </button>
      )}
      <button
        type="button"
        onClick={() => threads.openArtifactPane(thread.key)}
      >
        {W.allArtifacts}
      </button>
    </div>
  ) : null;

  return (
    <aside
      ref={paneRef}
      className={`artifact-pane${expanded ? " expanded" : ""}`}
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
      {contentMode === "browser" ? (
        <BrowserWorkspace
          taskKey={thread.key}
          active={active}
          client={browserWorkspaceClient}
        />
      ) : file ? (
        <FileArtifactView
          key={`${thread.key}:${roundId ?? "all"}:${file.path}`}
          card={file}
          threadKey={thread.key}
          workingDirectory={thread.cwd}
          active={active}
          headerActions={headerActions}
          headerSupplement={roundScope}
          fileSelector={fileSelector}
        />
      ) : (
        <>
          <div className="a-head">
            <span className="a-title">{W.outputChoice}</span>
            {headerActions}
          </div>
          {outputCopy?.key === copyKey && (
            <p className="a-note" role={outputCopy.ok ? "status" : "alert"}>
              {outputCopy.ok ? W.copied : W.copyFailed}
            </p>
          )}
          {roundScope}
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
            {cards.length === 0 && (
              <div className="a-empty">
                {scopedCards === null
                  ? W.roundArtifactsUnavailable
                  : STRINGS.artifacts.empty}
              </div>
            )}
            {cards.length > 0 && visibleOutputs.length === 0 && (
              <div className="a-empty" role="status">
                {O.empty}
              </div>
            )}
            {visibleOutputs.map((card, index) => (
              <CommandCard key={index} card={card} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
