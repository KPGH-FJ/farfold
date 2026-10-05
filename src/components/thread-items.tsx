import { usesMacShortcuts } from "../runtime/platform_shortcuts";
/**
 * Transcript item renderers (F 稿 steps/approval/diff/settled/raw).
 * User-facing vocabulary only — see PRODUCT.md §5.
 */
import { useEffect, useRef, useState, type MouseEventHandler } from "react";
import { CopyIcon } from "@phosphor-icons/react";
import {
  MessageAttachments,
  MessageFileLink,
  MessageResultLink,
  type OpenMessageFile,
} from "./MessageContent";
import { STRINGS } from "../runtime/strings";
import { THREAD_VIEW_STRINGS as T } from "../runtime/thread_view_strings";
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

function diffStats(content: ToolContent[]): {
  adds: number;
  dels: number;
} | null {
  let adds = 0;
  let dels = 0;
  for (const c of content) {
    if (c.type !== "diff") continue;
    adds += c.newText.split("\n").filter((l) => l.trim()).length;
    dels += (c.oldText ?? "").split("\n").filter((l) => l.trim()).length;
  }
  return adds || dels ? { adds, dels } : null;
}

function hasDetail(call: ToolCallView): boolean {
  return (
    call.content.length > 0 ||
    call.locations.length > 0 ||
    call.rawInput != null ||
    call.rawOutput !== undefined
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
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  const clipped = oldLines.length + newLines.length > DIFF_LINE_CAP;
  return (
    <div className="diff">
      <div className="h">
        <span>{path}</span>
        <span>
          {oldText === null ? STRINGS.thread.diffNew : STRINGS.thread.diffEdit}
        </span>
      </div>
      {oldLines.slice(0, clipped ? 8 : oldLines.length).map((l, i) => (
        <div key={`d${i}`} className="del">
          {"− " + l}
        </div>
      ))}
      {newLines.slice(0, clipped ? 24 : newLines.length).map((l, i) => (
        <div key={`a${i}`} className="add">
          {"+ " + l}
        </div>
      ))}
      {clipped && (
        <div className="more">
          … 其余 {oldLines.length + newLines.length - 32} 行
        </div>
      )}
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
          <pre className="step-text">{command}</pre>
        </>
      )}
      {cwd !== null && (
        <>
          <div className="step-locs">{STRINGS.thread.inputCwd}</div>
          <pre className="step-text">{cwd}</pre>
        </>
      )}
      <details className="raw-block">
        <summary>{STRINGS.thread.fullInput}</summary>
        <pre>{safeStringify(input)}</pre>
      </details>
    </div>
  );
}

function ToolDetail({
  call,
  onOpenFile,
}: {
  call: ToolCallView;
  onOpenFile?: OpenMessageFile;
}) {
  return (
    <div className="step-detail">
      <ToolInput input={call.rawInput} />
      {call.locations.length > 0 && (
        <div className="step-locs">
          {call.locations.map((location, index) => (
            <span key={index}>
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
            />
          );
        }
        if (c.type === "text") {
          return (
            <pre key={i} className="step-text">
              {c.text}
            </pre>
          );
        }
        if (c.type === "link") {
          return (
            <pre key={i} className="step-text">
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
          <pre key={i} className="step-text">
            {safeStringify(c.type === "raw" ? c.value : c)}
          </pre>
        );
      })}
      {call.rawOutput !== undefined && (
        <pre className="step-text">{rawOutputText(call.rawOutput)}</pre>
      )}
    </div>
  );
}

export function ToolStep({
  call,
  activity,
  onOpenArtifacts,
  onOpenFile,
}: {
  call: ToolCallView;
  activity?: "active" | "finished" | "unknown";
  onOpenArtifacts?: MouseEventHandler<HTMLButtonElement>;
  onOpenFile?: OpenMessageFile;
}) {
  const [open, setOpen] = useState(false);
  const glyph =
    activity === "unknown" ? { cls: "wait", ch: "?" } : stepGlyph(call.status);
  const stats = diffStats(call.content);
  const duration = durationLabel(call);
  const loc = call.locations[0]?.path;
  return (
    <>
      <div className="step">
        <span className={`g ${glyph.cls}`}>{glyph.ch}</span>
        <span className="cmd">
          {kindLabel(call.kind)} <b>{call.title || call.name || ""}</b>
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
            onClick={() => setOpen((v) => !v)}
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
              <span className="add">+{stats.adds}</span>{" "}
              <span className="del">−{stats.dels}</span>
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
      {open && <ToolDetail call={call} onOpenFile={onOpenFile} />}
    </>
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
            <span>{e.content}</span>
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
    <details className="raw-block">
      <summary>{label ?? STRINGS.thread.rawUpdate}</summary>
      <pre>{safeStringify(update)}</pre>
    </details>
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
  if (option.kind === "allow_once") return "↵";
  if (option.kind === "allow_always")
    return usesMacShortcuts() ? "⌘↵" : "Ctrl+Enter";
  if (option.kind === "reject_once") return "⌫";
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
}: {
  title: string;
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
        {T.approval}
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
