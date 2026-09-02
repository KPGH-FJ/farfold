import { useEffect, useMemo, useState } from "react";
import { ArrowUp, FolderSimple, Stop, X } from "@phosphor-icons/react";

interface CommandOption {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
}

interface ComposerProps {
  runtimeLabel?: string;
  supportsSteering?: boolean;
  running: boolean;
  ready: boolean;
  working: boolean;
  submitting: boolean;
  message: string;
  delivery: "steer" | "follow_up";
  projectName: string;
  contextPercent: number | null;
  commands: CommandOption[];
  lifeModelItems: Array<{ id: string; label: string }>;
  onMessage: (value: string) => void;
  onDelivery: (value: "steer" | "follow_up") => void;
  onSend: () => void;
  onAbort: () => void;
  onRemoveLifeModelItem: (itemId: string) => void;
  onOpenLifeModel: () => void;
}

export function Composer({
  runtimeLabel = "Pi",
  supportsSteering = true,
  running,
  ready,
  working,
  submitting,
  message,
  delivery,
  projectName,
  contextPercent,
  commands,
  lifeModelItems,
  onMessage,
  onDelivery,
  onSend,
  onAbort,
  onRemoveLifeModelItem,
  onOpenLifeModel,
}: ComposerProps) {
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [dismissedCommandValue, setDismissedCommandValue] = useState<
    string | null
  >(null);
  const commandQuery =
    message.startsWith("/") && !/\s/.test(message.slice(1))
      ? message.slice(1).toLocaleLowerCase()
      : null;
  const commandMatches = useMemo(
    () =>
      commandQuery === null
        ? []
        : commands
            .filter(
              (command) =>
                command.name.toLocaleLowerCase().includes(commandQuery) ||
                command.description?.toLocaleLowerCase().includes(commandQuery),
            )
            .slice(0, 8),
    [commandQuery, commands],
  );
  useEffect(() => setSelectedCommand(0), [commandQuery]);
  const visibleCommandMatches =
    dismissedCommandValue === message ? [] : commandMatches;

  function chooseCommand(index: number) {
    const command = commandMatches[index];
    if (command) onMessage(`/${command.name} `);
  }

  const sendLabel = submitting
    ? "正在提交"
    : working
      ? !supportsSteering
        ? "任务进行中"
        : delivery === "steer"
          ? "发送转向"
          : "加入跟进"
      : "发送";
  return (
    <section className={`composer${working ? " working" : ""}`}>
      {visibleCommandMatches.length > 0 && (
        <div
          className="command-menu"
          id="pi-command-menu"
          role="listbox"
          aria-label="Pi Commands"
        >
          <p>{runtimeLabel} Commands</p>
          {visibleCommandMatches.map((command, index) => (
            <button
              id={`pi-command-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === selectedCommand}
              className={index === selectedCommand ? "selected" : ""}
              key={`${command.source}-${command.name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(index)}
            >
              <span>
                <strong>/{command.name}</strong>
                <small>
                  {command.description || `${runtimeLabel} command`}
                </small>
              </span>
              <em>
                {command.source}
                {command.location ? ` · ${command.location}` : ""}
              </em>
            </button>
          ))}
        </div>
      )}
      {lifeModelItems.length > 0 && !working && (
        <div className="lifemodel-injection-preview" role="status">
          <strong>仅下一条消息</strong>
          {lifeModelItems.map((item) => (
            <span key={item.id}>
              <em>{item.label}</em>
              <button
                type="button"
                onClick={() => onRemoveLifeModelItem(item.id)}
                aria-label={`移除 LifeModel 上下文：${item.label}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <button type="button" onClick={onOpenLifeModel}>
            管理
          </button>
        </div>
      )}
      <textarea
        value={message}
        onChange={(event) => onMessage(event.target.value)}
        onKeyDown={(event) => {
          if (visibleCommandMatches.length > 0 && event.key === "Escape") {
            event.preventDefault();
            setDismissedCommandValue(message);
            return;
          }
          if (visibleCommandMatches.length > 0 && event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedCommand(
              (current) => (current + 1) % visibleCommandMatches.length,
            );
            return;
          }
          if (visibleCommandMatches.length > 0 && event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedCommand(
              (current) =>
                (current - 1 + visibleCommandMatches.length) %
                visibleCommandMatches.length,
            );
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (visibleCommandMatches.length > 0) {
              chooseCommand(selectedCommand);
              return;
            }
            onSend();
          }
        }}
        placeholder={
          running
            ? working && !supportsSteering
              ? `${runtimeLabel} 正在工作，可停止当前任务`
              : !ready
                ? `正在连接 ${runtimeLabel} 命令通道…`
                : working
                  ? "补充当前任务的方向…"
                  : "交给 Farfold 一个任务…"
            : `启动 ${runtimeLabel} 后即可开始`
        }
        disabled={!running || !ready}
        aria-label="输入消息"
        aria-autocomplete="list"
        aria-controls={
          visibleCommandMatches.length > 0 ? "pi-command-menu" : undefined
        }
        aria-expanded={visibleCommandMatches.length > 0}
        aria-activedescendant={
          visibleCommandMatches.length > 0
            ? `pi-command-option-${selectedCommand}`
            : undefined
        }
      />

      {working && supportsSteering && (
        <div className="delivery-row">
          <div className="segmented" aria-label="进行中消息类型">
            <button
              className={delivery === "steer" ? "active" : ""}
              onClick={() => onDelivery("steer")}
              aria-pressed={delivery === "steer"}
            >
              转向
            </button>
            <button
              className={delivery === "follow_up" ? "active" : ""}
              onClick={() => onDelivery("follow_up")}
              aria-pressed={delivery === "follow_up"}
            >
              跟进
            </button>
          </div>
          <span>
            {delivery === "steer" ? "当前工具完成后应用" : "当前任务结束后执行"}
          </span>
        </div>
      )}

      <div className="composer-footer">
        <div className="composer-meta">
          <span title={projectName}>
            <FolderSimple size={15} />
            {projectName}
          </span>
          <span>
            上下文{" "}
            {contextPercent === null ? "—" : `${Math.round(contextPercent)}%`}
          </span>
        </div>
        <div className="composer-buttons">
          {working && (
            <button
              className="stop-button"
              onClick={onAbort}
              title="停止当前任务"
            >
              <Stop size={14} weight="fill" />
              停止
            </button>
          )}
          <button
            className="send-button"
            onClick={onSend}
            disabled={!running || !ready || !message.trim() || submitting}
          >
            <span>{sendLabel}</span>
            <ArrowUp size={16} weight="bold" />
          </button>
        </div>
      </div>
    </section>
  );
}
