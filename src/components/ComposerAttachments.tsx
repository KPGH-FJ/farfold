import { useId, useRef, useState } from "react";
import type { DraftAttachment } from "../runtime/drafts";
import { draftImagePreview } from "../runtime/draft_images";
import { WORKSPACE_STRINGS as W } from "../runtime/workspace_strings";
import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import "../conversation-redesign.css";

/** Collapse presentation only; all attachments remain in the owner's draft. */
export function ComposerAttachments({
  items,
  onRemove,
}: {
  items: readonly DraftAttachment[];
  onRemove: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  if (!items.length) return null;
  const visible = expanded ? items : items.slice(0, 3);
  return (
    <section
      className="conversation-attachments"
      aria-label={R.attachments(items.length)}
    >
      <div className="conversation-attachments-heading">
        <span>{R.attachments(items.length)}</span>
        {items.length > 3 && (
          <button
            ref={toggle}
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? R.collapseAttachments
              : R.expandAttachments(items.length)}
          </button>
        )}
      </div>
      <div id={id} className={`c-chips${expanded ? " expanded" : ""}`}>
        {visible.map((chip) => {
          const preview = draftImagePreview(chip);
          return (
            <div key={chip.id} className="c-chip">
              {preview && <img src={preview} alt="" />}
              <span className="conversation-attachment-name">
                <span>{chip.name}</span>
                {expanded && chip.uri && <small>{chip.uri}</small>}
              </span>
              <button
                type="button"
                className="x"
                aria-label={W.removeAttachment(chip.name)}
                onClick={() => {
                  onRemove(chip.id);
                  toggle.current?.focus();
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
