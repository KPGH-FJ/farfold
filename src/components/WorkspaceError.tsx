import { X } from "@phosphor-icons/react";

export function WorkspaceError({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button onClick={onClose} aria-label="关闭错误">
        <X size={15} />
      </button>
    </div>
  );
}
