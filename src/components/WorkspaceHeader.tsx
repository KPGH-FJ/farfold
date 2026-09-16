import type { ComponentProps, ReactNode } from "react";
import {
  Brain,
  Command,
  FolderSimple,
  SidebarSimple,
} from "@phosphor-icons/react";
import { SessionTitle } from "./SessionTitle";

// Adapters supply model controls and native status; the workbench owns the
// location and behavior of common navigation and context actions.
export function WorkspaceHeader({
  session,
  modelControls,
  runtimeControls,
  lifeModelCount,
  onOpenLifeModel,
  projectPath,
  projectLabel,
  onChooseProject,
  projectLocked,
  runtimeStatus,
  working,
  contextOpen,
  onToggleContext,
  onOpenCommands,
  extensionStatus,
}: {
  session: ComponentProps<typeof SessionTitle>;
  modelControls: ReactNode;
  runtimeControls: ReactNode;
  lifeModelCount: number;
  onOpenLifeModel: () => void;
  projectPath: string | null;
  projectLabel: string;
  onChooseProject: () => void;
  projectLocked: boolean;
  runtimeStatus: string;
  working: boolean;
  contextOpen: boolean;
  onToggleContext: () => void;
  onOpenCommands: () => void;
  extensionStatus?: string;
}) {
  return (
    <header className="workspace-header">
      <SessionTitle key={session.sessionId ?? "unbound"} {...session} />
      <div className="header-meta">
        {modelControls}
        <span className="header-separator" />
        {runtimeControls}
        <span className="header-separator context-separator" />
        <button
          className="header-project"
          data-lifemodel-trigger
          onClick={onOpenLifeModel}
          title="打开 LifeModel"
        >
          <Brain size={14} />
          LifeModel{lifeModelCount ? ` · ${lifeModelCount}` : ""}
        </button>
        <span className="header-separator context-separator" />
        <button
          className="header-project"
          title={projectPath ?? undefined}
          onClick={onChooseProject}
          disabled={projectLocked}
        >
          <FolderSimple size={14} />
          {projectLabel}
        </button>
        <span className="header-separator context-separator" />
        <div className={`runtime-state${working ? " working" : ""}`}>
          <i />
          {runtimeStatus}
        </div>
        <button
          className="header-context"
          data-session-context-trigger
          type="button"
          aria-pressed={contextOpen}
          onClick={onToggleContext}
        >
          <SidebarSimple size={15} />
          详情
        </button>
        <button
          className="header-context header-command"
          type="button"
          aria-label="打开命令面板"
          title="命令面板（⌘⇧P）"
          onClick={onOpenCommands}
        >
          <Command size={15} />
          <span>命令</span>
        </button>
        {extensionStatus && (
          <span className="extension-status" title={extensionStatus}>
            {extensionStatus}
          </span>
        )}
      </div>
    </header>
  );
}
