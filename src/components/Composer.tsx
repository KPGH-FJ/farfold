import { useEffect, useMemo, useState } from "react";
import { ArrowUp, FolderSimple, Stop } from "@phosphor-icons/react";

interface ModelOption {
  provider: string;
  id: string;
  name?: string;
}

interface CommandOption {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  location?: "user" | "project" | "path";
}

interface ComposerProps {
  running: boolean;
  working: boolean;
  submitting: boolean;
  message: string;
  delivery: "steer" | "follow_up";
  projectName: string;
  model: ModelOption | null;
  models: ModelOption[];
  contextPercent: number | null;
  commands: CommandOption[];
  onMessage: (value: string) => void;
  onDelivery: (value: "steer" | "follow_up") => void;
  onSend: () => void;
  onAbort: () => void;
  onSelectModel: (value: string) => void;
}

function modelValue(model: ModelOption): string {
  return `${model.provider}/${model.id}`;
}

export function Composer({
  running,
  working,
  submitting,
  message,
  delivery,
  projectName,
  model,
  models,
  contextPercent,
  commands,
  onMessage,
  onDelivery,
  onSend,
  onAbort,
  onSelectModel,
}: ComposerProps) {
  const [selectedCommand, setSelectedCommand] = useState(0);
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

  function chooseCommand(index: number) {
    const command = commandMatches[index];
    if (command) onMessage(`/${command.name} `);
  }

  const sendLabel = submitting
    ? "正在提交"
    : working
      ? delivery === "steer"
        ? "发送转向"
        : "加入跟进"
      : "发送";
  return (
    <section className={`composer${working ? " working" : ""}`}>
      {commandMatches.length > 0 && (
        <div className="command-menu" role="listbox" aria-label="Pi Commands">
          <p>Pi Commands</p>
          {commandMatches.map((command, index) => (
            <button
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
                <small>{command.description || "Pi command"}</small>
              </span>
              <em>
                {command.source}
                {command.location ? ` · ${command.location}` : ""}
              </em>
            </button>
          ))}
        </div>
      )}
      <textarea
        value={message}
        onChange={(event) => onMessage(event.target.value)}
        onKeyDown={(event) => {
          if (commandMatches.length > 0 && event.key === "ArrowDown") {
            event.preventDefault();
            setSelectedCommand(
              (current) => (current + 1) % commandMatches.length,
            );
            return;
          }
          if (commandMatches.length > 0 && event.key === "ArrowUp") {
            event.preventDefault();
            setSelectedCommand(
              (current) =>
                (current - 1 + commandMatches.length) % commandMatches.length,
            );
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (commandMatches.length > 0) {
              chooseCommand(selectedCommand);
              return;
            }
            onSend();
          }
        }}
        placeholder={
          running
            ? working
              ? "补充当前任务的方向…"
              : "交给 Farfold 一个任务…"
            : "启动 Pi 后即可开始"
        }
        disabled={!running}
        aria-label="输入消息"
      />

      {working && (
        <div className="delivery-row">
          <div className="segmented" aria-label="进行中消息类型">
            <button
              className={delivery === "steer" ? "active" : ""}
              onClick={() => onDelivery("steer")}
            >
              转向
            </button>
            <button
              className={delivery === "follow_up" ? "active" : ""}
              onClick={() => onDelivery("follow_up")}
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
          <label>
            <span className="sr-only">Pi Model</span>
            <select
              value={model ? modelValue(model) : ""}
              onChange={(event) => onSelectModel(event.target.value)}
              disabled={!running || working}
            >
              <option value="" disabled>
                {models.length ? "选择模型" : "未发现模型"}
              </option>
              {models.map((item) => (
                <option key={modelValue(item)} value={modelValue(item)}>
                  {item.name ?? item.id}
                </option>
              ))}
            </select>
          </label>
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
            disabled={!running || !message.trim() || submitting}
          >
            <span>{sendLabel}</span>
            <ArrowUp size={16} weight="bold" />
          </button>
        </div>
      </div>
    </section>
  );
}
