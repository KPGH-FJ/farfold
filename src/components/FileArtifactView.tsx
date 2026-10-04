import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CaretDownIcon,
  ChatCircleTextIcon,
  CheckIcon,
  ColumnsIcon,
  CopyIcon,
  RowsIcon,
  XIcon,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  canPreviewHtml,
  filePresentation,
  lineDiff,
  splitDiffRows,
  staticPreviewDocument,
  STATIC_PREVIEW_SANDBOX,
  type FileArtifact,
  type DiffLine,
} from "../runtime/artifact_view";
import {
  fileFeedbackKey,
  fileFeedbackDrafts,
  useFileFeedback,
} from "../runtime/drafts";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { fileFeedbackText } from "../runtime/feedback_strings";
import { FileFeedbackDrafts } from "./FileFeedbackDrafts";
import { FileDeliveryActions } from "./FileDeliveryActions";
import type { VerifiedFile } from "../runtime/file_delivery";
import {
  isSelectedLine,
  parseFeedbackSelection,
  selectionInput,
  type FeedbackSelection as Selection,
} from "../runtime/file_feedback";

type Mode =
  | "diff"
  | "after"
  | "before"
  | "compare"
  | "read-after"
  | "read-before"
  | "preview";

/** Identifies the Agent-reported revision without storing its body in drafts. */
function feedbackContentId(before: string | null, after: string) {
  let hash = 2166136261;
  const text = `${before ?? ""}\u0000${after}`;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
const PAGE_LINES = 400;

function DocumentText({ text }: { text: string }) {
  return (
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
        {text}
      </ReactMarkdown>
    </div>
  );
}

function NumberedText({
  text,
  side,
  onLine,
  fragment,
  selection,
}: {
  text: string;
  side: Selection["side"];
  onLine: (selection: Selection) => void;
  fragment: boolean;
  selection: Selection | null;
}) {
  const [limit, setLimit] = useState(PAGE_LINES);
  const lines = text.split("\n");
  return (
    <>
      <div className="artifact-code">
        {lines.slice(0, limit).map((line, index) => (
          <div
            className={`artifact-code-row${isSelectedLine(selection, side, index + 1) ? " selected-line" : ""}`}
            key={index}
          >
            <button
              type="button"
              className="artifact-line-number"
              aria-label={
                fragment ? W.fragmentLine(index + 1) : W.lineLabel(index + 1)
              }
              onClick={() => onLine({ line: index + 1, side })}
            >
              {index + 1}
            </button>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
      {lines.length > limit && (
        <button
          type="button"
          className="artifact-more"
          onClick={() => setLimit(limit + PAGE_LINES)}
        >
          {W.showMore}
        </button>
      )}
    </>
  );
}

export function FileDifference({
  card,
  onLine,
  split = false,
  selection = null,
}: {
  card: FileArtifact;
  onLine: (selection: Selection) => void;
  split?: boolean;
  selection?: Selection | null;
}) {
  const rows = useMemo(
    () => lineDiff(card.oldText, card.newText),
    [card.oldText, card.newText],
  );
  const [limit, setLimit] = useState(PAGE_LINES);
  const paired = useMemo(
    () => (split ? splitDiffRows(rows) : []),
    [rows, split],
  );
  const lineLabel = card.scope === "fragment" ? W.fragmentLine : W.lineLabel;
  const cell = (row: DiffLine | null, side: Selection["side"]) => {
    const line = side === "before" ? row?.oldLine : row?.newLine;
    const selected = isSelectedLine(selection, side, line ?? null);
    return (
      <div
        className={`artifact-split-cell ${row?.kind ?? "gap"}${selected ? " selected-line" : ""}`}
      >
        <button
          type="button"
          className="artifact-line-number"
          disabled={!line}
          aria-pressed={selected}
          aria-label={
            line
              ? `${side === "before" ? W.fileBefore : W.fileAfter} · ${lineLabel(line)}`
              : undefined
          }
          onClick={() => line && onLine({ line, side })}
        >
          {line ?? ""}
        </button>
        <code>{row?.text || " "}</code>
      </div>
    );
  };
  return (
    <>
      {split ? (
        <div className="artifact-split-code">
          <div className="artifact-split-heading">
            <span>
              {card.oldText === null ? W.missingOriginal : W.fileBefore}
            </span>
            <span>{W.fileAfter}</span>
          </div>
          {paired.slice(0, limit).map((row, index) => (
            <div className="artifact-split-row" key={index}>
              {cell(row.before, "before")}
              {cell(row.after, "after")}
            </div>
          ))}
        </div>
      ) : (
        <div className="artifact-code artifact-difference">
          {rows.slice(0, limit).map((row, index) => (
            <div
              className={`artifact-code-row ${row.kind}${isSelectedLine(selection, "before", row.oldLine) || isSelectedLine(selection, "after", row.newLine) ? " selected-line" : ""}`}
              key={index}
            >
              <button
                type="button"
                className="artifact-line-number"
                disabled={row.oldLine === null}
                aria-label={
                  row.oldLine
                    ? `${W.fileBefore} · ${lineLabel(row.oldLine)}`
                    : undefined
                }
                onClick={() =>
                  row.oldLine && onLine({ line: row.oldLine, side: "before" })
                }
              >
                {row.oldLine ?? ""}
              </button>
              <button
                type="button"
                className="artifact-line-number"
                disabled={row.newLine === null}
                aria-label={
                  row.newLine
                    ? `${W.fileAfter} · ${lineLabel(row.newLine)}`
                    : undefined
                }
                onClick={() =>
                  row.newLine && onLine({ line: row.newLine, side: "after" })
                }
              >
                {row.newLine ?? ""}
              </button>
              <span className="artifact-line-sign">
                {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
              </span>
              <code>{row.text || " "}</code>
            </div>
          ))}
        </div>
      )}
      {(split ? paired.length : rows.length) > limit && (
        <button
          type="button"
          className="artifact-more"
          onClick={() => setLimit(limit + PAGE_LINES)}
        >
          {W.showMore}
        </button>
      )}
    </>
  );
}

export function StaticHtmlPreview({ card }: { card: FileArtifact }) {
  const available = canPreviewHtml(card);
  const srcDoc = useMemo(
    () => (available ? staticPreviewDocument(card.newText) : ""),
    [card.newText, available],
  );
  if (!available) return null;
  return (
    <>
      <div className="artifact-preview-note">{W.previewNote}</div>
      <iframe
        title={card.path}
        sandbox={STATIC_PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </>
  );
}

export function FileArtifactView({
  card,
  threadKey,
  headerActions,
  headerSupplement,
  fileSelector,
  workingDirectory,
  onOpenHtml,
  onOpenFile,
  active = true,
}: {
  card: FileArtifact;
  threadKey: string;
  headerActions?: ReactNode;
  headerSupplement?: ReactNode;
  fileSelector?: ReactNode;
  workingDirectory?: string;
  onOpenHtml?: (file: VerifiedFile) => void;
  onOpenFile?: (path: string) => void;
  active?: boolean;
}) {
  const presentation = filePresentation(card);
  const previewAvailable = canPreviewHtml(card);
  const [requestedMode, setMode] = useState<Mode>("diff");
  const contentId = useMemo(
    () => feedbackContentId(card.oldText, card.newText),
    [card.oldText, card.newText],
  );
  const feedbackDraft = useFileFeedback(threadKey, card.path, contentId);
  const feedback = feedbackDraft.text;
  const selection =
    feedbackDraft.contentId === contentId ? feedbackDraft.selection : null;
  const setSelection = (value: Selection | null) =>
    fileFeedbackDrafts.update(threadKey, card.path, {
      ...fileFeedbackDrafts.read(threadKey, card.path, contentId),
      contentId,
      scope: card.scope,
      selection: value,
      lineInput: undefined,
    });
  const setFeedback = (value: string) =>
    fileFeedbackDrafts.update(threadKey, card.path, {
      ...fileFeedbackDrafts.read(threadKey, card.path, contentId),
      contentId,
      scope: card.scope,
      selection,
      text: value,
    });
  const [added, setAdded] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(Boolean(feedback));
  const [split, setSplit] = useState(false);
  const [copied, setCopied] = useState<"content" | "path" | "failed" | null>(
    null,
  );
  const copyRequest = useRef(0);
  const [previewWidth, setPreviewWidth] = useState("fit");
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const options: { mode: Mode; label: string }[] = [
    { mode: "diff", label: W.fileDiff },
  ];
  if (presentation === "markdown") {
    options.push(
      { mode: "compare", label: W.documentCompare },
      { mode: "read-after", label: W.documentAfter },
    );
    if (card.oldText !== null)
      options.push({ mode: "read-before", label: W.documentBefore });
    options.push({ mode: "after", label: W.fileSource });
  } else {
    if (previewAvailable)
      options.push({ mode: "preview", label: W.pagePreview });
    options.push({
      mode: "after",
      label: presentation === "html" ? W.fileSource : W.fileAfter,
    });
    if (card.oldText !== null)
      options.push({ mode: "before", label: W.fileBefore });
  }
  const mode = options.some((option) => option.mode === requestedMode)
    ? requestedMode
    : "after";
  useEffect(() => {
    setCopied(null);
    return () => {
      copyRequest.current += 1;
    };
  }, [threadKey, card.path, card.oldText, card.newText, mode]);
  useEffect(() => {
    setFeedbackOpen(
      Boolean(fileFeedbackDrafts.read(threadKey, card.path, contentId).text),
    );
    setAdded(false);
  }, [threadKey, card.path, contentId]);
  useEffect(() => {
    if (feedbackOpen) feedbackRef.current?.focus();
  }, [feedbackOpen]);
  const selectLine = (value: Selection) => {
    setSelection(value);
    setAdded(false);
    setFeedbackOpen(true);
    feedbackRef.current?.focus();
  };
  const copyingBefore = mode === "before" || mode === "read-before";
  const copyLabel =
    mode === "diff"
      ? W.copyDiff
      : card.scope === "fragment"
        ? W.copyFragment
        : copyingBefore
          ? W.copyOriginal
          : W.copyFile;
  const location = selection
    ? `${selection.side === "before" ? W.fileBefore : W.fileAfter} · ${W.feedbackRange(selectionInput(selection), card.scope === "fragment")}`
    : "";
  const lineSide =
    feedbackDraft.lineInput?.side ??
    selection?.side ??
    (copyingBefore ? "before" : "after");
  const lineInput = feedbackDraft.lineInput?.text ?? selectionInput(selection);
  const lineCount = (
    lineSide === "before" ? (card.oldText ?? "") : card.newText
  ).split("\n").length;
  const lineInvalid = Boolean(
    lineInput.trim() && !parseFeedbackSelection(lineInput, lineSide, lineCount),
  );
  const editLineInput = (text: string, side = lineSide) => {
    const count = (
      side === "before" ? (card.oldText ?? "") : card.newText
    ).split("\n").length;
    fileFeedbackDrafts.update(threadKey, card.path, {
      ...fileFeedbackDrafts.read(threadKey, card.path, contentId),
      contentId,
      scope: card.scope,
      selection: parseFeedbackSelection(text, side, count),
      lineInput: { side, text },
    });
    setAdded(false);
  };
  const copy = async (target: "content" | "path") => {
    const request = ++copyRequest.current;
    setCopied(null);
    const text =
      target === "path"
        ? card.path
        : mode === "diff"
          ? lineDiff(card.oldText, card.newText)
              .map(
                (row) =>
                  `${row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}${row.text}`,
              )
              .join("\n")
          : copyingBefore
            ? (card.oldText ?? "")
            : card.newText;
    try {
      await navigator.clipboard.writeText(text);
      if (request === copyRequest.current) setCopied(target);
    } catch {
      if (request === copyRequest.current) setCopied("failed");
    }
  };
  return (
    <section className="file-artifact-view">
      <div className="a-head">
        <div className="artifact-heading">
          <span className="a-title">
            {presentation === "markdown"
              ? W.contentMarkdown
              : presentation === "html"
                ? W.contentHtml
                : W.contentCode}
          </span>
          <span className="artifact-select">
            <select
              aria-label={W.viewMode}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as Mode);
                setCopied(null);
              }}
            >
              {options.map((option) => (
                <option key={option.mode} value={option.mode}>
                  {option.label}
                </option>
              ))}
            </select>
            <CaretDownIcon
              className="artifact-select-caret"
              size={11}
              aria-hidden="true"
            />
          </span>
        </div>
        {headerActions}
      </div>
      {headerSupplement}
      <div
        className="artifact-view-toolbar"
        role="group"
        aria-label={W.fileChoice}
      >
        {fileSelector ?? (
          <span className="artifact-file-name" title={card.path}>
            {card.path.split("/").pop()}
          </span>
        )}
        <div className="artifact-view-actions">
          {mode === "diff" && (
            <div className="artifact-diff-modes">
              <button
                type="button"
                className={!split ? "selected" : ""}
                aria-pressed={!split}
                title={W.unifiedDiff}
                onClick={() => setSplit(false)}
              >
                <RowsIcon size={13} />
                <span>{W.unifiedDiff}</span>
              </button>
              <button
                type="button"
                className={split ? "selected" : ""}
                aria-pressed={split}
                title={W.splitDiff}
                onClick={() => setSplit(true)}
              >
                <ColumnsIcon size={13} />
                <span>{W.splitDiff}</span>
              </button>
            </div>
          )}
          {mode === "preview" && (
            <span className="artifact-select">
              <select
                aria-label={W.previewWidth}
                value={previewWidth}
                onChange={(event) => setPreviewWidth(event.target.value)}
              >
                <option value="fit">{W.previewFit}</option>
                <option value="768">{W.previewTablet}</option>
                <option value="390">{W.previewPhone}</option>
              </select>
              <CaretDownIcon
                className="artifact-select-caret"
                size={11}
                aria-hidden="true"
              />
            </span>
          )}
          <button
            type="button"
            className="artifact-icon-button"
            title={copied === "path" ? W.copied : W.copyPath}
            aria-label={copied === "path" ? W.copied : W.copyPath}
            onClick={() => copy("path")}
          >
            {copied === "path" ? (
              <CheckIcon size={15} />
            ) : (
              <CopyIcon size={15} />
            )}
          </button>
          <button
            type="button"
            className="artifact-icon-button"
            title={copied === "content" ? W.copied : copyLabel}
            aria-label={copied === "content" ? W.copied : copyLabel}
            onClick={() => copy("content")}
          >
            {copied === "content" ? (
              <CheckIcon size={15} />
            ) : (
              <CopyIcon size={15} />
            )}
          </button>
          <button
            type="button"
            className="artifact-icon-button"
            title={feedbackOpen ? W.feedbackClose : W.feedbackOpen}
            aria-label={feedbackOpen ? W.feedbackClose : W.feedbackOpen}
            aria-expanded={feedbackOpen}
            onClick={() => {
              setFeedbackOpen(!feedbackOpen);
              setAdded(false);
            }}
          >
            <ChatCircleTextIcon size={15} />
          </button>
        </div>
      </div>
      {workingDirectory && (
        <FileDeliveryActions
          card={card}
          workingDirectory={workingDirectory}
          active={active}
          onOpenHtml={onOpenHtml}
          onOpenFile={onOpenFile}
          identity={JSON.stringify([
            threadKey,
            workingDirectory,
            card.path,
            card.source,
            card.status,
            card.time,
            card.oldText,
            card.newText,
          ])}
        />
      )}
      <div
        className={`artifact-file-content${mode === "preview" ? " preview" : ""}`}
      >
        {mode === "diff" && (
          <FileDifference
            card={card}
            onLine={selectLine}
            split={split}
            selection={selection}
          />
        )}
        {(mode === "after" || mode === "before") && (
          <NumberedText
            key={mode}
            text={mode === "before" ? (card.oldText ?? "") : card.newText}
            side={mode}
            onLine={selectLine}
            fragment={card.scope === "fragment"}
            selection={selection}
          />
        )}
        {mode === "compare" && (
          <div className="artifact-document-compare">
            <section>
              <h3>{W.fileBefore}</h3>
              {card.oldText === null ? (
                <p>{W.missingOriginal}</p>
              ) : (
                <DocumentText text={card.oldText} />
              )}
            </section>
            <section>
              <h3>{W.fileAfter}</h3>
              <DocumentText text={card.newText} />
            </section>
          </div>
        )}
        {(mode === "read-after" || mode === "read-before") && (
          <DocumentText
            text={mode === "read-before" ? (card.oldText ?? "") : card.newText}
          />
        )}
        {mode === "preview" && (
          <div
            className="artifact-preview-viewport"
            style={{
              width: previewWidth === "fit" ? "100%" : `${previewWidth}px`,
            }}
          >
            <StaticHtmlPreview card={card} />
          </div>
        )}
      </div>
      {feedbackOpen && (
        <form
          className="artifact-feedback"
          onSubmit={(event) => {
            event.preventDefault();
            if (!feedback.trim() || lineInvalid) return;
            const key = fileFeedbackKey(card.path, contentId);
            const current = fileFeedbackDrafts.entries(threadKey)[key];
            if (
              !current ||
              !fileFeedbackDrafts.take(
                threadKey,
                key,
                fileFeedbackText(current),
              )
            )
              return;
            setAdded(true);
            setFeedbackOpen(false);
          }}
        >
          <div className="artifact-feedback-line-input">
            <label>
              <span>{W.feedbackLine}</span>
              <input
                aria-label={W.feedbackLine}
                placeholder={W.feedbackLinePlaceholder}
                value={lineInput}
                aria-invalid={lineInvalid}
                onChange={(event) => editLineInput(event.target.value)}
              />
            </label>
            <select
              aria-label={W.feedbackLineSide}
              value={lineSide}
              onChange={(event) =>
                editLineInput(
                  lineInput,
                  event.target.value as Selection["side"],
                )
              }
            >
              {card.oldText !== null && (
                <option value="before">{W.fileBefore}</option>
              )}
              <option value="after">{W.fileAfter}</option>
            </select>
          </div>
          <p
            className="artifact-feedback-line-hint"
            role={lineInvalid ? "alert" : undefined}
          >
            {lineInvalid
              ? W.feedbackLineInvalid(lineCount)
              : card.scope === "fragment"
                ? W.feedbackFragmentLines
                : W.feedbackFileLines}
          </p>
          {(selection || lineInput) && (
            <div className="artifact-feedback-location">
              <span>{location}</span>
              <button
                type="button"
                aria-label={W.feedbackClearLine}
                onClick={() => setSelection(null)}
              >
                <XIcon size={12} />
              </button>
            </div>
          )}
          <textarea
            ref={feedbackRef}
            aria-label={W.feedbackLabel}
            placeholder={W.feedbackPlaceholder}
            value={feedback}
            onChange={(event) => {
              setFeedback(event.target.value);
              setAdded(false);
            }}
            rows={2}
          />
          <div>
            <span role="status">{added ? W.feedbackAdded : ""}</span>
            <button type="submit" disabled={!feedback.trim() || lineInvalid}>
              {W.feedbackAdd}
            </button>
          </div>
        </form>
      )}
      <FileFeedbackDrafts
        threadKey={threadKey}
        path={card.path}
        excludeContentId={contentId}
      />
      <div className="artifact-provenance" role="note">
        <span>{card.source === "diff" ? W.fileReported : W.fileInput}</span>
        {card.scope === "fragment" && <span>{W.fragmentNote}</span>}
        {card.status === "failed" ? (
          <span className="failed">{W.fileFailed}</span>
        ) : card.status !== "completed" ? (
          <span>{W.filePending}</span>
        ) : null}
        {presentation === "html" && !previewAvailable && (
          <span>{W.incompleteHtml}</span>
        )}
        {(copied || added) && (
          <span
            role="status"
            className={copied === "failed" ? "failed" : undefined}
          >
            {copied === "failed"
              ? W.copyFailed
              : copied
                ? W.copied
                : W.feedbackAdded}
          </span>
        )}
      </div>
    </section>
  );
}
