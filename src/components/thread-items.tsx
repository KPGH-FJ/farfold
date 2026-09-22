/**
 * Transcript item renderers (F 稿 steps/approval/diff/settled/raw).
 * User-facing vocabulary only — see PRODUCT.md §5.
 */
import { useState } from "react";
import { STRINGS } from "../runtime/strings";
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

/* ── 步骤流 ── */

const KIND_LABEL: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Bash",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Mode",
  other: "Tool",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? "Tool";
}

function durationLabel(call: ToolCallView): string | null {
  if (call.status !== "completed" && call.status !== "failed") return null;
  if (call.startedAt <= 0 || call.endedAt === undefined)
    return STRINGS.thread.toolDurationUnknown;
  const end = call.endedAt;
  const secs = Math.max(0, (end - call.startedAt) / 1000);
  if (secs < 0.5) return "<1s";
  if (secs < 60) return `${secs.toFixed(1)}s`;
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
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

function ToolDetail({ call }: { call: ToolCallView }) {
  return (
    <div className="step-detail">
      {call.locations.length > 0 && (
        <div className="step-locs">
          {call.locations
            .map((l) => `${l.path}${l.line ? `:${l.line}` : ""}`)
            .join("  ")}
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
              {c.name + "\n" + c.uri}
            </pre>
          );
        }
        if (c.type === "image") {
          return (
            <pre key={i} className="step-text">
              {STRINGS.thread.imageBlock(c.mimeType)}
            </pre>
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

export function ToolStep({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const glyph = stepGlyph(call.status);
  const stats = diffStats(call.content);
  const duration = durationLabel(call);
  const loc = call.locations[0]?.path;
  return (
    <>
      <div className="step">
        <span className={`g ${glyph.cls}`}>{glyph.ch}</span>
        <span className="cmd">
          {kindLabel(call.kind)} <b>{call.title || call.name || ""}</b>
          {loc && <span className="loc">{loc}</span>}
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
        <span className="tail">
          {stats && (
            <>
              <span className="add">+{stats.adds}</span>{" "}
              <span className="del">−{stats.dels}</span>
              {" · "}
            </>
          )}
          {call.status === "in_progress" ? "…" : (duration ?? "")}
        </span>
      </div>
      {open && <ToolDetail call={call} />}
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
  if (option.kind === "allow_always") return "⌘↵";
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
  options,
  onPick,
}: {
  title: string;
  kind: string;
  locations: { path: string }[];
  options: PermissionOption[];
  onPick: (option: PermissionOption) => void;
}) {
  const ordered = [...options].sort((a, b) => {
    const rank = (k: string) => (k.startsWith("allow") ? 0 : 1);
    return rank(a.kind) - rank(b.kind);
  });
  return (
    <div className="approval">
      <div className="tag">
        <i />
        {STRINGS.thread.needYou}
      </div>
      <div className="ap-title">{title || STRINGS.thread.permissionOther}</div>
      <div className="ap-sub">{permissionSubtitle(kind, locations)}</div>
      <div className="ap-actions">
        {ordered.map((option) => {
          const kbd = optionKbd(option);
          return (
            <button
              key={option.optionId}
              type="button"
              className={optionClass(option)}
              onClick={() => onPick(option)}
            >
              {optionLabel(option)}
              {kbd && <span className="kbd">{kbd}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
