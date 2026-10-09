import React, { useId, useRef, useState } from "react";
import { CaretDown, Paperclip, X } from "@phosphor-icons/react";
import { attachmentName } from "./composer-examples.js";
export default function AttachmentList({
  files = [],
  onRemove,
  label = "附件",
  disabled = false,
}) {
  const [expanded, setExpanded] = useState(false);
  const region = useId();
  const toggle = useRef(null);
  if (!files.length) return null;
  const shown = expanded ? files : files.slice(0, 3);
  return (
    <section className="complete-attachments" aria-label={label}>
      <button
        ref={toggle}
        className="complete-attachments-toggle"
        aria-expanded={expanded}
        aria-controls={region}
        onClick={() => setExpanded((value) => !value)}
      >
        <Paperclip size={15} />
        <span>{expanded ? "收起附件" : `展开全部 ${files.length} 个附件`}</span>
        <CaretDown size={14} />
      </button>
      <ul id={region}>
        {shown.map((file, index) => {
          const path = attachmentName(file);
          return (
            <li key={`${path}-${index}`}>
              <span title={path}>
                {path.split("/").pop()}
                {expanded && <small>{path}</small>}
              </span>
              {onRemove && (
                <button
                  disabled={disabled}
                  aria-label={`移除附件 ${path}`}
                  onClick={() => {
                    onRemove(file, index);
                    requestAnimationFrame(() => toggle.current?.focus());
                  }}
                >
                  <X size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!expanded && files.length > 3 && (
        <small>
          另有 {files.length - 3} 个附件，展开后可查看完整名称和位置。
        </small>
      )}
    </section>
  );
}
