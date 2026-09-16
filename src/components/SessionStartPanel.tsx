import type { ReactNode } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import appIconUrl from "../../assets/app-icon.svg";

export function SessionStartPanel({
  title,
  description,
  connection,
  projectPath,
  projectLocked = false,
  chooseProject,
  busy,
  unavailable,
  children,
  resume,
  create,
  primaryLabel,
}: {
  title: string;
  description: string;
  connection: ReactNode;
  projectPath: string | null;
  projectLocked?: boolean;
  chooseProject: () => void;
  busy: boolean;
  unavailable: boolean;
  children?: ReactNode;
  resume?: () => void;
  create: () => void;
  primaryLabel: string;
}) {
  const disabled = busy || unavailable || !projectPath;
  return (
    <div className="start-state">
      <img src={appIconUrl} alt="" />
      <h2>{title}</h2>
      <p>{description}</p>
      {connection}
      <button
        className="project-picker"
        onClick={chooseProject}
        disabled={busy || projectLocked}
      >
        <FolderOpen size={20} />
        <span>
          <small>Project · Working Copy</small>
          <strong>{projectPath ?? "选择文件夹"}</strong>
        </span>
      </button>
      {children}
      <div className="start-actions">
        <button
          className="start-primary"
          onClick={resume ?? create}
          disabled={disabled}
        >
          {primaryLabel}
        </button>
        {resume && (
          <button onClick={create} disabled={disabled}>
            新建 Session
          </button>
        )}
      </div>
    </div>
  );
}
