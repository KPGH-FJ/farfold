import { useRef, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { updateHostSessionMetadata } from "../runtime/host-session-metadata";
import { cleanManualSessionTitle } from "../runtime/session-title";

interface Props {
  sessionId?: string;
  title: string;
  displayTitle?: string;
  disabled: boolean;
  onError: (message: string) => void;
}

/** Key by Host Session ID so switching conversations discards an unfinished edit. */
export function SessionTitle({
  sessionId,
  title,
  displayTitle,
  disabled,
  onError,
}: Props) {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const locked = disabled || saving;

  async function save() {
    if (!sessionId || locked || inFlight.current) return;
    if (!draft.trim()) {
      onError("请填写一个可识别的对话标题。");
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      await updateHostSessionMetadata({
        farfoldSessionId: sessionId,
        title: cleanManualSessionTitle(draft, 80),
      });
      setEditing(false);
    } catch (reason) {
      onError(String(reason));
    } finally {
      setSaving(false);
      inFlight.current = false;
    }
  }

  return editing ? (
    <form
      className="session-title-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        aria-label="对话标题"
        value={draft}
        disabled={locked}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) {
            event.preventDefault();
            setEditing(false);
          }
        }}
      />
      <button type="submit" disabled={locked}>
        {saving ? "保存中…" : "保存"}
      </button>
      <button type="button" disabled={saving} onClick={() => setEditing(false)}>
        取消
      </button>
    </form>
  ) : (
    <div className="session-title">
      <h1 title={title}>
        {displayTitle ?? cleanManualSessionTitle(title, 34)}
      </h1>
      {sessionId && (
        <button
          className="session-title-edit"
          aria-label="重命名对话"
          title="重命名对话"
          disabled={locked}
          onClick={() => {
            setDraft(title);
            setEditing(true);
          }}
        >
          <PencilSimple size={14} />
        </button>
      )}
    </div>
  );
}
