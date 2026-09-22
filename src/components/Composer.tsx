import { configCheckMessage } from "../runtime/config_check";
/**
 * 消息栏（F 稿 .composer）：自动增高、Enter/Shift+Enter、IME 安全、
 * 粘贴图片（需 promptCapabilities.image）、@ 或 + 添加文件、
 * 运行中排队显示、停止按钮。
 */
import { uiError } from "../runtime/ui_error";
import { traceAfterPaint } from "../runtime/performance-trace";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import {
  filterCommands,
  filterFiles,
  mentionAnchor,
  mentionQuery,
  slashQuery,
} from "../runtime/commands";
import {
  basename,
  threads,
  type PromptBlock,
  type ThreadState,
} from "../runtime/sessions";
import { useWorkPolicy } from "../runtime/work_policy";
import { STRINGS } from "../runtime/strings";

interface AttachmentChip {
  kind: "file" | "image";
  name: string;
  uri?: string;
  data?: string;
  mimeType?: string;
  /** File text when the agent supports embedded context; otherwise the
   *  chip sends a `resource_link` only. */
  content?: string;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  thread,
  imageEnabled,
  embedContext = false,
  onGoSettings,
  onSend,
  autofocus = true,
  disabled: disabledProp = false,
  note,
  noteAction = false,
  fit = false,
}: {
  thread: ThreadState | null;
  imageEnabled: boolean;
  /** `promptCapabilities.embeddedContext` — `@` picks embed file text. */
  embedContext?: boolean;
  onGoSettings: () => void;
  /** When provided, the composer drives a not-yet-open conversation
   *  (start page). Otherwise it sends into `thread`. */
  onSend?: (blocks: PromptBlock[]) => void | Promise<void>;
  autofocus?: boolean;
  disabled?: boolean;
  /** Extra note shown above the box (start-page errors/hints). */
  note?: string | null;
  /** Whether the note gets a「去设置」link (errors — not selection hints). */
  noteAction?: boolean;
  /** Fill its parent column (start page) instead of the 680px measure. */
  fit?: boolean;
}) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const [focus, setFocus] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // `@` mention picker: anchor = index of the triggering `@` in `text`;
  // query is the text after it (closes on whitespace or deletion).
  const [mentionAt, setMentionAt] = useState(-1);
  const [pickIndex, setPickIndex] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const filesCwd = useRef<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = useRef(false);

  const work = useWorkPolicy(thread?.cwd ?? null);
  const running = thread?.running ?? false;
  const queued = thread?.queued ?? [];
  const disabled =
    disabledProp ||
    (thread
      ? thread.openError !== null ||
        thread.reconnecting ||
        thread.configuring ||
        thread.modelDrift ||
        !work.enabled(thread.agentId)
      : false);

  const autogrow = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  // Slash popup: whole input is a single `/token` and the agent declared
  // commands. Mention popup: live query after the `@` anchor.
  const commands = thread?.availableCommands ?? [];
  const slashQ = slashQuery(text);
  const slashOpen = slashQ !== null && commands.length > 0;
  const slashList = slashOpen ? filterCommands(commands, slashQ) : [];
  const mentionQ = mentionAt >= 0 ? mentionQuery(text, mentionAt) : null;
  const mentionOpen = mentionQ !== null;
  const fileList = mentionOpen ? filterFiles(files ?? [], mentionQ) : [];
  const pickListLen = slashOpen ? slashList.length : fileList.length;

  // Lazy project file list, cached per cwd for the session lifetime.
  const cwd = thread?.cwd ?? null;
  useEffect(() => {
    if (!mentionOpen || !cwd || filesCwd.current === cwd) return;
    filesCwd.current = cwd;
    invoke<{ files: string[] }>("project_files", { cwd })
      .then((result) => setFiles(result.files))
      .catch(() => setFiles([]));
  }, [mentionOpen, cwd]);

  useEffect(() => setPickIndex(0), [slashQ, mentionQ]);

  const pickSlash = (index: number) => {
    const command = slashList[index];
    if (!command) return;
    setText(`/${command.name} `);
    areaRef.current?.focus();
    requestAnimationFrame(autogrow);
  };

  const pickFile = (index: number) => {
    const rel = fileList[index];
    if (!rel || !cwd) return;
    const uri = `file://${cwd}/${rel}`;
    setChips((prev) => [
      ...prev,
      { kind: "file" as const, name: basename(rel), uri },
    ]);
    if (embedContext) {
      // Agents that accept embedded context get the file text, not just a
      // link — read failures degrade to the link, never block the pick.
      invoke<string>("project_file_read", { cwd, path: rel })
        .then((content) =>
          setChips((prev) =>
            prev.map((chip) =>
              chip.uri === uri ? { ...chip, content } : chip,
            ),
          ),
        )
        .catch(() => undefined);
    }
    setText((prev) => prev.slice(0, mentionAt));
    setMentionAt(-1);
    areaRef.current?.focus();
    requestAnimationFrame(autogrow);
  };

  const blocks = (): PromptBlock[] => {
    const out: PromptBlock[] = [];
    const trimmed = text.trim();
    if (trimmed) out.push({ type: "text", text: trimmed });
    for (const chip of chips) {
      if (chip.kind === "image" && chip.data) {
        out.push({
          type: "image",
          data: chip.data,
          mimeType: chip.mimeType ?? "image/png",
        });
      } else if (chip.kind === "file" && chip.uri) {
        if (chip.content !== undefined) {
          out.push({
            type: "resource",
            resource: {
              uri: chip.uri,
              mimeType: "text/plain",
              text: chip.content,
            },
          });
        } else {
          out.push({ type: "resource_link", name: chip.name, uri: chip.uri });
        }
      }
    }
    return out;
  };

  const canSend = (text.trim() || chips.length > 0) && !disabled;

  const doSend = async () => {
    if (!canSend || busy.current) return;
    busy.current = true;
    setSendError(null);
    setPlusOpen(false);
    setMentionAt(-1);
    const payload = blocks();
    try {
      if (onSend) {
        await onSend(payload);
      } else if (thread) {
        await threads.send(thread.key, payload);
      }
      setText("");
      setChips([]);
      requestAnimationFrame(autogrow);
    } catch (error) {
      setSendError(uiError(error, STRINGS.repair.sendFailed));
    } finally {
      busy.current = false;
    }
  };

  const doStop = async () => {
    if (!thread || stopping || thread.stopping) return;
    setStopping(true);
    await threads.cancel(thread.key);
    setStopping(false);
  };

  const pickFiles = async () => {
    const picked = await openDialog({ multiple: true });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setChips((prev) => [
      ...prev,
      ...paths.map((p) => ({
        kind: "file" as const,
        name: basename(p),
        uri: `file://${p}`,
      })),
    ]);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    // Agent 不支持图片时按规格忽略。
    if (!imageEnabled) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    for (const file of files) {
      void fileToDataUrl(file).then((url) => {
        const data = url.split(",")[1] ?? "";
        setChips((prev) => [
          ...prev,
          {
            kind: "image",
            name: `pasted.${(file.type.split("/")[1] ?? "png").split(";")[0]}`,
            data,
            mimeType: file.type,
          },
        ]);
      });
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    traceAfterPaint("input_paint");
    const value = e.target.value;
    // 「@」在开头或空白后 → 打开项目文件选择（picker 读光标前的
    // 子串做模糊匹配；选中后整段 `@query` 从文本中移除换成 chip）。
    const at = mentionAnchor(value);
    if (at >= 0) setMentionAt(at);
    setText(value);
    autogrow();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen || mentionOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPickIndex(
          (prev) =>
            (prev +
              (e.key === "ArrowDown" ? 1 : -1) +
              Math.max(pickListLen, 1)) %
            Math.max(pickListLen, 1),
        );
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        if (slashOpen) pickSlash(pickIndex);
        else pickFile(pickIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (mentionOpen) {
          setText((prev) => prev.slice(0, mentionAt));
          setMentionAt(-1);
          requestAnimationFrame(autogrow);
        }
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void doSend();
  };

  const openNote =
    thread?.openError ??
    thread?.configError ??
    sendError ??
    (thread && work.ready && !work.enabled(thread.agentId)
      ? STRINGS.repair.workOff
      : null) ??
    work.error ??
    (thread?.modelDrift
      ? (configCheckMessage(thread.configCheck) ?? STRINGS.repair.modelDrifted)
      : null) ??
    note ??
    null;
  const showAction = Boolean(thread?.openError || sendError || noteAction);

  return (
    <div className={`composer${fit ? " fit" : ""}`}>
      {queued.map((blocksOfOne, i) => {
        const preview = blocksOfOne
          .map((b) =>
            b.type === "text"
              ? b.text
              : b.type === "image"
                ? STRINGS.composer.imageChip
                : `[${b.type === "resource" ? basename(b.resource.uri) : b.name}]`,
          )
          .join(" ")
          .slice(0, 60);
        return (
          <div key={i} className="queued">
            <span className="q-tag">{STRINGS.composer.queued(i + 1)}</span>
            <span>{preview}</span>
            {thread && (
              <span
                className="q-x"
                onClick={() => threads.dequeue(thread.key, i)}
              >
                ×
              </span>
            )}
          </div>
        );
      })}
      {queued.length > 0 && (
        <div className="auth-note" style={{ marginTop: -4 }}>
          <span>
            {thread?.uncertainPrompt
              ? STRINGS.repair.uncertain
              : thread?.queuePaused
                ? STRINGS.repair.queuePaused
                : STRINGS.composer.queuedTail}
          </span>
          {thread?.queuePaused && (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={
                disabled ||
                thread.running ||
                thread.submitting ||
                thread.stopUnconfirmed ||
                !!thread.uncertainPrompt
              }
              onClick={() => void threads.continueQueue(thread.key)}
            >
              {STRINGS.repair.continueQueue}
            </button>
          )}
        </div>
      )}
      {openNote && (
        <div className="auth-note">
          <span>{openNote}</span>
          {showAction && (
            <a onClick={onGoSettings}>{STRINGS.empty.goSettings}</a>
          )}
        </div>
      )}
      {slashOpen && slashList.length > 0 && (
        <div className="pick-menu" role="listbox">
          {slashList.map((command, i) => (
            <div
              key={command.name}
              role="option"
              aria-selected={i === pickIndex}
              className={`pm${i === pickIndex ? " on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(i);
              }}
            >
              <span className="pm-name">/{command.name}</span>
              {command.description && (
                <span className="pm-desc">{command.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div className="pick-menu" role="listbox">
          {fileList.map((file, i) => (
            <div
              key={file}
              role="option"
              aria-selected={i === pickIndex}
              className={`pm${i === pickIndex ? " on" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickFile(i);
              }}
            >
              <span className="pm-name">{basename(file)}</span>
              <span className="pm-desc">{file}</span>
            </div>
          ))}
          {fileList.length === 0 && (
            <div className="pm pm-dim">{STRINGS.composer.noFileMatch}</div>
          )}
        </div>
      )}
      <div className={`composer-box${focus ? " focus" : ""}`}>
        {chips.length > 0 && (
          <div className="c-chips">
            {chips.map((chip, i) => (
              <span key={i} className="c-chip">
                {chip.data && (
                  <img
                    src={`data:${chip.mimeType};base64,${chip.data}`}
                    alt=""
                  />
                )}
                {chip.name}
                <button
                  type="button"
                  className="x"
                  onClick={() =>
                    setChips((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
          className="c-input"
          placeholder={
            running
              ? STRINGS.composer.placeholderRunning
              : thread && thread.identity === "draft"
                ? STRINGS.composer.placeholderFirst
                : STRINGS.composer.placeholder
          }
          rows={1}
          value={text}
          disabled={disabled}
          autoFocus={autofocus}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
        <div className="c-row">
          <div className="c-tools">
            <button
              type="button"
              className="icon-btn"
              title={STRINGS.composer.addTitle}
              onClick={() => setPlusOpen((v) => !v)}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="c-actions">
            <span className="c-hint">
              {running ? STRINGS.composer.hintQueue : STRINGS.composer.hintSend}
            </span>
            {running ? (
              <button
                type="button"
                className="c-stop"
                title={
                  thread?.stopping
                    ? STRINGS.repair.stopping
                    : STRINGS.composer.stopTitle
                }
                onClick={() => void doStop()}
              >
                {thread?.stopping ? STRINGS.repair.stopping : <i />}
              </button>
            ) : (
              <button
                type="button"
                className={`c-send${canSend ? "" : " empty"}`}
                title={STRINGS.composer.sendTitle}
                onClick={() => void doSend()}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {plusOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
            onClick={() => setPlusOpen(false)}
          />
          <div className="plus-menu">
            <div
              className="pm"
              onClick={() => {
                setPlusOpen(false);
                void pickFiles();
              }}
            >
              {STRINGS.composer.addFile}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
