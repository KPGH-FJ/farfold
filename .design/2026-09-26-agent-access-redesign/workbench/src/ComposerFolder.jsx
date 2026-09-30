import React, { useState } from "react";
import { FolderSimple, X } from "@phosphor-icons/react";
import { Modal, Button } from "./ui.jsx";

export default function ComposerFolder({ folder, onChoose, onRemove }) {
  const [open, setOpen] = useState(false);
  if (!folder) return null;
  return (
    <>
      <span className="composer-folder">
        <button
          type="button"
          aria-label={`查看资料文件夹 ${folder}`}
          title={folder}
          onClick={() => setOpen(true)}
        >
          <FolderSimple size={14} />
          {folder.split("/").filter(Boolean).pop() || folder}
        </button>
        {onRemove && (
          <button aria-label="移除文件夹" onClick={onRemove}>
            <X size={12} />
          </button>
        )}
      </span>
      {open && (
        <Modal title="资料文件夹" onClose={() => setOpen(false)}>
          <p className="composer-folder-path">{folder}</p>
          {onChoose ? (
            <Button
              onClick={() => {
                setOpen(false);
                onChoose();
              }}
            >
              更换文件夹
            </Button>
          ) : (
            <p className="v2-help">这段对话使用此文件夹。</p>
          )}
        </Modal>
      )}
    </>
  );
}
