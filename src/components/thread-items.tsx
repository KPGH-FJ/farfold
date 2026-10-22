import { usesMacShortcuts } from "../runtime/platform_shortcuts";
import {
  compareLines,
  comparisonFor,
  type LineComparison,
} from "../runtime/line_diff";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { DiffComparisonNote } from "./DiffComparisonNote";
/**
 * Transcript item renderers (F 稿 steps/approval/diff/settled/raw).
 * User-facing vocabulary only — see PRODUCT.md §5.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
} from "react";
import { CopyIcon } from "@phosphor-icons/react";
import {
  MessageAttachments,
  MessageFileLink,
  MessageResultLink,
  type OpenMessageFile,
} from "./MessageContent";
import { TRANSCRIPT_SEARCH as S } from "../runtime/transcript_search_strings";
import { STRINGS } from "../runtime/strings";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
import { ReportedDetails } from "./ReportedDetails";
import { SearchDisclosure, useSearchExpansion } from "./transcript-search";
import { MessageMediaVisibility } from "./message-media-visibility";
import type {
  PermissionOption,
  PlanEntry,
  ToolCallView,
  ToolContent,
} from "../runtime/sessions";

export function timeLabel(millis: number): string {
  if (!millis) return STRINGS.thread.historyMessage;
  const d = new Date(millis);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

export function MessageCopyButton({ text }: { text: string }) {
  const request = useRef(0);
  const [feedback, setFeedback] = useState<{
    text: string;
    ok: boolean;
  } | null>(null);
  useEffect(() => {
    setFeedback(null);
    return () => {
      request.current += 1;
    };
  }, [text]);
  const copy = async () => {
    const current = ++request.current;
    try {
      await navigator.clipboard.writeText(text);
      if (current === request.current) setFeedback({ text, ok: true });
    } catch {
      if (current === request.current) setFeedback({ text, ok: false });
    }
  };
  return (
    <span className="message-copy" data-copy-exclude>
      <button
        type="button"
        aria-label={T.copyMessage}
        title={T.copyMessage}
        onClick={() => void copy()}
      >
        <CopyIcon size={13} aria-hidden="true" />
      </button>
      {feedback?.text === text && (
        <span role="status">{feedback.ok ? T.copied : T.copyFailed}</span>
      )}
    </span>
  );
}

/* ── 步骤流 ── */

function kindLabel(kind: string): string {
  return Object.hasOwn(T.toolKinds, kind)
    ? T.toolKinds[kind as keyof typeof T.toolKinds]
    : kind
      ? T.unknownToolKind(kind)
      : T.toolKinds.other;
}

/** Completion describes the step's state, not a verified side effect. */
function toolSummary(kind: string): string {
  const category = Object.hasOwn(T.toolKinds, kind)
    ? T.toolKinds[kind as keyof typeof T.toolKinds]
    : T.toolKinds.other;
  return `${category} · ${T.toolEnded}`;
}

function durationLabel(call: ToolCallView): string | null {
  if (call.status !== "completed" && call.status !== "failed") return null;
  if (call.startedAt <= 0 || call.endedAt === undefined)
    return STRINGS.thread.toolDurationUnknown;
  const end = call.endedAt;
  const secs = Math.max(0, (end - call.startedAt) / 1000);
  if (secs < 0.5) return "<1s";
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const rounded = Math.round(secs);
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

function diffStats(content: ToolContent[]) {
  const results = content
    .filter((c) => c.type === "diff")
    .map((c) => comparisonFor(c));
  if (!results.length) return null;
  return {
    exact: results.every((r) => r.stats !== null),
    adds: results.reduce((sum, r) => sum + (r.stats?.adds ?? 0), 0),
    dels: results.reduce((sum, r) => sum + (r.stats?.removes ?? 0), 0),
    endings: results.reduce((sum, r) => sum + r.endingChanges.length, 0),
  };
}

function hasDetail(call: ToolCallView): boolean {
  return (
    call.content.length > 0 ||
    call.locations.length > 0 ||
    call.rawInput != null ||
    call.rawOutput !== undefined ||
    Boolean(call.reportedDetails && Object.keys(call.reportedDetails).length)
  );
}

function stepGlyph(status: string): { cls: string; ch: string } {
  switch (status) {
    case "completed":
      return { cls: "ok", ch: "✓" };
    case "failed":
      return { cls: "fail", ch: "✗" };
    case "in_progress":
      return { cls: "run", ch: "⟳" };
    default:
      return { cls: "wait", ch: "○" };
  }
}

const DIFF_LINE_CAP = 40;

export function DiffView({
  path,
  oldText,
  newText,
  comparison,
  status,
  onOpenFile,
}: {
  path: string;
  oldText: string | null;
  newText: string;
  comparison?: LineComparison;
  status?: string;
  onOpenFile?: OpenMessageFile;
}) {
  const expansion = useSearchExpansion();
  const result = useMemo(
    () => comparison ?? compareLines(oldText, newText),
    [comparison, oldText, newText],
  );
  const raw = result.precision === "unavailable";
  const clipped = result.rows.length > DIFF_LINE_CAP;
  const previewRows = 32;
  const shown = result.rows.slice(
    0,
    !clipped || expansion.materialized ? undefined : previewRows,
  );
  return (
    <div className="diff" ref={expansion.ref}>
      <div className="h">
        <span data-find-block>
          <MessageFileLink path={path} onOpenFile={onOpenFile}>
            {path}
          </MessageFileLink>
        </span>
        <span>{W.diffFragment}</span>
      </div>
      <DiffComparisonNote result={result} fragment />
      {raw
        ? expansion.materialized && (
            <div hidden={!expansion.open}>
              {oldText !== null ? (
                <>
                  <span>{W.fileBefore}</span>
                  <pre data-find-block>{oldText}</pre>
                </>
              ) : (
                <p>{W.missingOriginal}</p>
              )}
              <span>{W.fileAfter}</span>
              <pre data-find-block>{newText}</pre>
            </div>
          )
        : shown.map((row, index) => (
            <div
              key={index}
              className={
                result.precision !== "aligned"
                  ? "ctx"
                  : row.kind === "remove"
                    ? "del"
                    : row.kind === "add"
                      ? "add"
                      : "ctx"
              }
              hidden={clipped && !expansion.open && index >= previewRows}
            >
              {result.precision === "replacement" &&
                row.kind !== "same" &&
                row.kind !== shown[index - 1]?.kind && (
                  <div className="diff-side">
                    {row.kind === "remove" ? W.fileBefore : W.fileAfter}
                  </div>
                )}
              {result.precision !== "aligned"
                ? "  "
                : row.kind === "remove"
                  ? "− "
                  : row.kind === "add"
                    ? "+ "
                    : "  "}
              <span data-find-block>{row.text}</span>
            </div>
          ))}
      {(clipped || raw) && (
        <div className="more">
          <button
            type="button"
            className="step-toggle"
            aria-expanded={expansion.open}
            onClick={expansion.toggle}
          >
            {expansion.open
              ? S.collapseDiff
              : raw
                ? W.diffShowRaw
                : S.expandDiff(result.rows.length - previewRows)}
          </button>
        </div>
      )}
      {status && status !== "completed" && (
        <p className="diff-status">
          {status === "failed"
            ? W.fileFailed
            : status === "pending" || status === "in_progress"
              ? W.filePending
              : W.fileUnknown}
        </p>
      )}
      <details className="diff-provenance">
        <summary>{W.diffDetails}</summary>
        <p>{W.fileReported}</p>
        <p>{W.fragmentNote}</p>
      </details>
    </div>
  );
}

/** `rawOutput` rendered in a step's detail: the string itself, an
 *  object's `output` field, or the whole value serialized. */
function rawOutputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const output = (raw as { output?: unknown }).output;
    if (typeof output === "string") return output;
  }
  return safeStringify(raw);
}

function ToolInput({
  input,
  showMissing = false,
}: {
  input: unknown;
  showMissing?: boolean;
}) {
  if (input === undefined || input === null)
    return showMissing ? (
      <p className="ap-sub">{STRINGS.thread.permissionInputMissing}</p>
    ) : null;
  const fields =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const command = typeof fields?.command === "string" ? fields.command : null;
  const cwd = typeof fields?.cwd === "string" ? fields.cwd : null;
  return (
    <div className="tool-input">
      {command !== null && (
        <>
          <div className="step-locs">{STRINGS.thread.inputCommand}</div>
          <pre className="step-text" data-find-block>
            {command}
          </pre>
        </>
      )}
      {cwd !== null && (
        <>
          <div className="step-locs">{STRINGS.thread.inputCwd}</div>
          <pre className="step-text" data-find-block>
            {cwd}
          </pre>
        </>
      )}
      <SearchDisclosure
        className="raw-block"
        renderBody={() => <pre data-find-block>{safeStringify(input)}</pre>}
      >
        <summary>{STRINGS.thread.fullInput}</summary>
      </SearchDisclosure>
    </div>
  );
}

function ToolDetail({
  call,
  activity,
  onOpenFile,
}: {
  call: ToolCallView;
  activity?: "active" | "finished" | "unknown";
  onOpenFile?: OpenMessageFile;
}) {
  return (
    <div className="step-detail">
      <div className="step-locs">
        {kindLabel(call.kind)}
        {call.title || call.name ? (
          <>
            {" "}
            · <span data-find-block>{call.title || call.name}</span>
          </>
        ) : (
          ""
        )}
      </div>
      <ToolInput input={call.rawInput} />
      {call.locations.length > 0 && (
        <div className="step-locs">
          {call.locations.map((location, index) => (
            <span key={index} data-find-block>
              {index > 0 && "  "}
              <MessageFileLink path={location.path} onOpenFile={onOpenFile}>
                {location.path}
                {location.line ? `:${location.line}` : ""}
              </MessageFileLink>
            </span>
          ))}
        </div>
      )}
      {call.content.map((c, i) => {
        if (c.type === "diff") {
          return (
            <DiffView
              key={i}
              path={c.path}
              oldText={c.oldText}
              newText={c.newText}
              comparison={comparisonFor(c)}
              status={activity === "unknown" ? "unknown" : call.status}
              onOpenFile={onOpenFile}
            />
          );
        }
        if (c.type === "text") {
          return (
            <pre key={i} className="step-text" data-find-block>
              {c.text}
            </pre>
          );
        }
        if (c.type === "link") {
          return (
            <pre key={i} className="step-text" data-find-block>
              <MessageResultLink href={c.uri} onOpenFile={onOpenFile}>
                {c.name}
              </MessageResultLink>
              {"\n" + c.uri}
            </pre>
          );
        }
        if (c.type === "attachment") {
          return (
            <MessageAttachments
              key={i}
              attachments={[c.attachment]}
              onOpenFile={onOpenFile}
            />
          );
        }
        return (
          <pre key={i} className="step-text" data-find-block>
            {safeStringify(c.type === "raw" ? c.value : c)}
          </pre>
        );
      })}
      {call.rawOutput !== undefined && (
        <pre className="step-text" data-find-block>
          {rawOutputText(call.rawOutput)}
        </pre>
      )}
      <ReportedDetails details={call.reportedDetails} />
    </div>
  );
}

export function ToolStep({
  call,
  transcriptItemId,
  activity,
  onOpenArtifacts,
  onOpenFile,
}: {
  call: ToolCallView;
  transcriptItemId?: string;
  activity?: "active" | "finished" | "unknown";
  onOpenArtifacts?: MouseEventHandler<HTMLButtonElement>;
  onOpenFile?: OpenMessageFile;
}) {
  const expansion = useSearchExpansion();
  const glyph =
    activity === "unknown" ? { cls: "wait", ch: "?" } : stepGlyph(call.status);
  const stats = diffStats(call.content);
  const duration = durationLabel(call);
  const loc = call.locations[0]?.path;
  return (
    <div
      ref={expansion.ref}
      data-tool-item={transcriptItemId}
      tabIndex={transcriptItemId ? -1 : undefined}
    >
      <div className="step">
        <span className={`g ${glyph.cls}`}>{glyph.ch}</span>
        <span className="cmd">
          {call.status === "completed" && activity !== "unknown"
            ? toolSummary(call.kind)
            : kindLabel(call.kind)}
          {loc && (
            <span className="loc">
              <MessageFileLink path={loc} onOpenFile={onOpenFile}>
                {loc}
              </MessageFileLink>
            </span>
          )}
        </span>
        {hasDetail(call) && (
          <button
            type="button"
            className="step-toggle"
            aria-expanded={expansion.open}
            onClick={expansion.toggle}
          >
            {STRINGS.thread.toolDetail}
          </button>
        )}
        {onOpenArtifacts && (
          <button
            type="button"
            className="step-toggle"
            onClick={onOpenArtifacts}
          >
            {T.viewArtifacts}
          </button>
        )}
        <span className="tail">
          {stats && (
            <>
              {stats.exact ? (
                <span title={W.diffReports}>
                  <span className="add">+{stats.adds}</span>{" "}
                  <span className="del">−{stats.dels}</span>
                </span>
              ) : (
                <span>{W.diffPartial}</span>
              )}
              {stats.endings > 0 && (
                <span> · {W.diffEndings(stats.endings)}</span>
              )}
              {" · "}
            </>
          )}
          {activity === "unknown"
            ? STRINGS.thread.toolResultUnknown
            : call.status === "in_progress"
              ? "…"
              : (duration ?? "")}
        </span>
      </div>
      {expansion.materialized && (
        <div hidden={!expansion.open}>
          <MessageMediaVisibility visible={expansion.open}>
            <ToolDetail
              call={call}
              activity={activity}
              onOpenFile={onOpenFile}
            />
          </MessageMediaVisibility>
        </div>
      )}
    </div>
  );
}

/* ── 计划 ── */

export function PlanBlock({ entries }: { entries: PlanEntry[] }) {
  return (
    <div className="plan">
      <div className="plan-label">{STRINGS.thread.plan}</div>
      {entries.map((e, i) => {
        const cls =
          e.status === "completed"
            ? "done"
            : e.status === "in_progress"
              ? "active"
              : "";
        const ch =
          e.status === "completed"
            ? "✓"
            : e.status === "in_progress"
              ? "⟳"
              : "○";
        return (
          <div key={i} className={`plan-item ${cls}`}>
            <span className="pg">{ch}</span>
            <span data-find-block>{e.content}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── 未识别更新（折叠保留） ── */

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function RawBlock({
  update,
  label,
}: {
  update: unknown;
  label?: string;
}) {
  return (
    <SearchDisclosure
      className="raw-block"
      renderBody={() => <pre data-find-block>{safeStringify(update)}</pre>}
    >
      <summary>{label ?? STRINGS.thread.rawUpdate}</summary>
    </SearchDisclosure>
  );
}

/* ── 审批卡 ── */

function optionLabel(option: PermissionOption): string {
  switch (option.kind) {
    case "allow_once":
      return STRINGS.thread.approve;
    case "allow_always":
      return STRINGS.thread.approveRemember;
    case "reject_once":
      return STRINGS.thread.reject;
    case "reject_always":
      return STRINGS.thread.rejectForever;
    default:
      return option.name || option.optionId;
  }
}

function optionClass(option: PermissionOption): string {
  if (option.kind === "allow_once") return "btn btn-primary";
  if (option.kind === "allow_always") return "btn btn-ghost";
  return "btn btn-text";
}

function optionKbd(option: PermissionOption): string | null {
  // Bare Enter/Backspace never decide — every approval needs the modifier.
  const mac = usesMacShortcuts();
  if (option.kind === "allow_once") return mac ? "⌘↵" : "Ctrl+Enter";
  if (option.kind === "allow_always") return mac ? "⌘⌥↵" : "Ctrl+Alt+Enter";
  if (option.kind === "reject_once") return mac ? "⌘⌫" : "Ctrl+Backspace";
  return null;
}

function permissionSubtitle(
  kind: string,
  locations: { path: string }[],
): string {
  const file = locations[0]?.path;
  switch (kind) {
    case "execute":
      return STRINGS.thread.permissionCommand;
    case "edit":
    case "delete":
    case "move":
      return STRINGS.thread.permissionEdit + (file ? ` · ${file}` : "");
    default:
      return file
        ? `${STRINGS.thread.permissionOther} · ${file}`
        : STRINGS.thread.permissionOther;
  }
}

export function ApprovalCard({
  title,
  kind,
  locations,
  rawInput,
  options,
  onPick,
  disabled = false,
  statusLabel,
}: {
  title: string;
  statusLabel?: string;
  kind: string;
  locations: { path: string }[];
  rawInput?: unknown;
  options: PermissionOption[];
  onPick: (option: PermissionOption) => void;
  disabled?: boolean;
}) {
  const ordered = [...options].sort((a, b) => {
    const rank = (k: string) => (k.startsWith("allow") ? 0 : 1);
    return rank(a.kind) - rank(b.kind);
  });
  return (
    <div className="approval">
      <div className="tag">
        <i />
        {statusLabel ?? T.approval}
      </div>
      <div className="ap-title">{title || STRINGS.thread.permissionOther}</div>
      <div className="ap-sub">{permissionSubtitle(kind, locations)}</div>
      <ToolInput input={rawInput} showMissing />
      <div className="ap-actions">
        {ordered.map((option) => {
          const kbd = optionKbd(option);
          const label = optionLabel(option);
          return (
            <button
              key={option.optionId}
              type="button"
              className={optionClass(option)}
              disabled={disabled}
              onClick={() => onPick(option)}
            >
              <span>{label}</span>
              {option.name && option.name !== label && (
                <small className="permission-option-detail">
                  {option.name}
                </small>
              )}
              {kbd && <span className="kbd">{kbd}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
