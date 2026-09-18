/**
 * 消息栏（F 稿 .composer）：自动增高、Enter/Shift+Enter、IME 安全、
 * 粘贴图片（需 promptCapabilities.image）、@ 或 + 添加文件、
 * 运行中排队显示、停止按钮。
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import {
  basename,
  threads,
  type PromptBlock,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

interface AttachmentChip {
  kind: "file" | "image";
  name: string;
  uri?: string;
  data?: string;
  mimeType?: string;
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
  onGoSettings,
  onSend,
  autofocus = true,
  disabled: disabledProp = false,
  note,
  fit = false,
}: {
  thread: ThreadState | null;
  imageEnabled: boolean;
  onGoSettings: () => void;
  /** When provided, the composer drives a not-yet-open conversation
   *  (start page). Otherwise it sends into `thread`. */
  onSend?: (blocks: PromptBlock[]) => void | Promise<void>;
  autofocus?: boolean;
  disabled?: boolean;
  /** Extra note shown above the box (start-page errors/hints). */
  note?: string | null;
  /** Fill its parent column (start page) instead of the 680px measure. */
  fit?: boolean;
}) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const [focus, setFocus] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = useRef(false);

  const running = thread?.running ?? false;
  const queued = thread?.queued ?? [];
  const disabled = disabledProp || (thread ? thread.openError !== null : false);

  const autogrow = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
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
        out.push({ type: "resource_link", name: chip.name, uri: chip.uri });
      }
    }
    return out;
  };

  const canSend = (text.trim() || chips.length > 0) && !disabled;

  const doSend = async () => {
    if (!canSend || busy.current) return;
    busy.current = true;
    setSendError(null);
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
      setSendError(String(error));
    } finally {
      busy.current = false;
    }
  };

  const doStop = async () => {
    if (!thread || stopping) return;
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
    const value = e.target.value;
    // 「@」触发文件选择：空输入或以空白/换行结尾后的 @。
    if (value === "@" || /(^|\s)@$/.test(value)) {
      setText(value.replace(/@$/, ""));
      requestAnimationFrame(autogrow);
      void pickFiles();
      return;
    }
    setText(value);
    autogrow();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    void doSend();
  };

  const openNote = thread?.openError ?? sendError ?? note ?? null;

  return (
    <div className={`composer${fit ? " fit" : ""}`}>
      {queued.map((blocksOfOne, i) => {
        const preview = blocksOfOne
          .map((b) =>
            b.type === "text"
              ? b.text
              : b.type === "image"
                ? STRINGS.composer.imageChip
                : `[${b.name}]`,
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
          <span>{STRINGS.composer.queuedTail}</span>
        </div>
      )}
      {openNote && (
        <div className="auth-note">
          <span>{openNote}</span>
          <a onClick={onGoSettings}>{STRINGS.empty.goSettings}</a>
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
              : thread && !thread.prompted
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
                title={STRINGS.composer.stopTitle}
                onClick={() => void doStop()}
              >
                <i />
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
