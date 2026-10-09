import AttachmentList from "./AttachmentList.jsx";
import React, { useEffect, useRef, useState } from "react";
import FileFeedback from "./FileFeedback.jsx";
import FilePreviewState, { FilePreviewReview } from "./FilePreviewState.jsx";
import {
  Archive,
  ArrowClockwise,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Copy,
  DotsThree,
  FileText,
  FolderSimple,
  ListBullets,
  LockKey,
  MagnifyingGlass,
  Paperclip,
  Pause,
  PencilSimple,
  Play,
  Square,
  TerminalWindow,
  Trash,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { AgentIcon, Badge, Button, Modal, Notice, Status } from "./ui";

const FILES = [
  {
    path: "src/components/ProjectCard.tsx",
    label: "ProjectCard.tsx",
    adds: 8,
    dels: 3,
    lines: [
      ["ctx", "export function ProjectCard({ project, onOpen }) {"],
      ["del", "  return <div onClick={() => onOpen(project.id)}>"],
      ["add", "  return <button"],
      ["add", '    type="button"'],
      ["add", '    className="project-card"'],
      ["add", "    onClick={() => onOpen(project.id)}"],
      ["add", "    aria-label={`打开 ${project.name}`}"],
      ["add", "  >"],
      ["ctx", '    <FolderIcon aria-hidden="true" />'],
      ["del", "    <span>{project.name}</span>"],
      ["add", '    <span className="project-name">{project.name}</span>'],
      ["ctx", "    <span>{project.taskCount} 个对话</span>"],
      ["del", "  </div>;"],
      ["add", "  </button>;"],
      ["ctx", "}"],
    ],
  },
  {
    path: "src/styles/project.css",
    label: "project.css",
    adds: 10,
    dels: 0,
    lines: [
      ["ctx", ".project-card {"],
      ["ctx", "  display: flex;"],
      ["ctx", "  align-items: center;"],
      ["add", "  gap: 12px;"],
      ["add", "  border: 1px solid var(--border);"],
      ["add", "  border-radius: 12px;"],
      ["add", "  background: var(--surface);"],
      ["add", "  padding: 16px;"],
      ["ctx", "}"],
      ["add", ".project-card:focus-visible {"],
      ["add", "  outline: 2px solid var(--accent);"],
      ["add", "  outline-offset: 3px;"],
      ["add", "}"],
      ["add", ".project-name { flex: 1; text-align: left; }"],
    ],
  },
  {
    path: "src/components/ProjectCard.test.tsx",
    label: "ProjectCard.test.tsx",
    adds: 7,
    dels: 0,
    lines: [
      ["add", 'it("supports keyboard navigation", async () => {'],
      ["add", "  const onOpen = vi.fn();"],
      ["add", "  render(<ProjectCard project={sample} onOpen={onOpen} />);"],
      ["add", "  await user.tab();"],
      ["add", '  await user.keyboard("{Enter}");'],
      ["add", "  expect(onOpen).toHaveBeenCalledWith(sample.id);"],
      ["add", "});"],
    ],
  },
];
const TERMINAL =
  "$ npm run test -- ProjectCard\n\n ✓ ProjectCard.test.tsx  (4 tests)  118ms\n   ✓ shows project name and conversation count\n   ✓ opens the selected project\n   ✓ supports keyboard navigation\n   ✓ shows a visible focus ring\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  1.24s\n\nProcess exited with code 0";
const LOGS = [
  { time: "14:32:04", kind: "读取", text: "已读取 ProjectCard.tsx 与项目样式" },
  { time: "14:32:06", kind: "修改", text: "调整卡片语义，并补充键盘焦点样式" },
  { time: "14:32:09", kind: "批准", text: "你允许在本次对话运行 npm run test" },
  { time: "14:32:11", kind: "命令", text: "测试执行结束，退出码 0" },
];
const INITIAL_APPROVALS = [
  {
    id: "test",
    title: "运行项目卡片测试",
    kind: "command",
    detail: "npm run test -- ProjectCard",
    description: "检查这次修改是否影响点击与键盘操作。",
    scope: "仅本次对话内的 npm run test 命令",
    remember: true,
  },
  {
    id: "write",
    title: "更新项目卡片与样式",
    kind: "file",
    detail: "src/components/ProjectCard.tsx · src/styles/project.css",
    description: "将键盘操作和焦点样式写入这两个文件。",
    scope: "仅本次文件修改",
    remember: false,
  },
];

const normalQueue = (queue) =>
  (queue || []).map((q, i) =>
    typeof q === "string" ? { id: `queued-${i}`, text: q } : q,
  );
const normalMessages = (messages) =>
  (messages || []).map((message) =>
    typeof message === "string" ? { text: message, attachments: [] } : message,
  );
const isPresetTask = (task) =>
  ["travel", "writing"].includes(task.demoKind) ||
  [
    "approval",
    "question",
    "running",
    "done",
    "recovery",
    "unknown",
    "archived",
  ].includes(task.id);
const hasPresetResults = (task) =>
  Boolean(task.hasPresetResults) ||
  (!task.resultMode && ["done", "archived"].includes(task.id)) ||
  (task.resultMode === "preset" && task.status === "done");
function SentAttachments({ attachments = [] }) {
  return <AttachmentList files={attachments} label="随消息发送的附件" />;
}
function SimulationResult({ plan = false, note = "" }) {
  return (
    <section className="conv-result">
      <div className="conv-result-label">
        <CheckCircle size={20} />
        <strong>{plan ? "方向草案" : "已收到"}</strong>
        <Badge>示例</Badge>
      </div>
      {plan && <h2>先确认方向，再调整界面</h2>}
      {plan ? (
        <>
          <p>
            根据你的选择，先提供一个可以讨论的方向：保留项目名称与状态的清晰层级，把常用操作收在卡片内，使用轻量焦点和选中反馈。
          </p>
          <ul>
            <li>卡片信息：名称、最近活动、需要处理的事项。</li>
            <li>操作反馈：悬停显示更多操作，键盘聚焦时显示清晰轮廓。</li>
            <li>下一步：你确认方向后，再决定调整的范围。</li>
          </ul>
          {note && <p>你补充的要求：{note}</p>}
          <p>
            还没有修改文件或执行测试。待发消息已暂停，等待你确认方案或提出新的要求。
          </p>
        </>
      ) : (
        <p>
          已记录你的要求。你可以继续补充、添加文件，或把下一步加入待发。此处为界面演示，尚未实际执行。
        </p>
      )}
    </section>
  );
}
const projectName = (project) =>
  typeof project === "string" ? project : project?.name || "Farfold";

function Step({
  icon: Icon = FileText,
  title,
  detail,
  duration,
  live = false,
  waiting = false,
  children,
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`conv-step ${live ? "live" : ""}`}>
      <button
        type="button"
        className="conv-step-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`conv-step-state ${live || waiting ? "" : "done"}`}>
          {live || waiting ? <Clock size={15} /> : <Check size={14} />}
        </span>
        <Icon size={16} />
        <span className="conv-step-title">
          {title}
          <small>{detail}</small>
        </span>
        <span className="conv-step-duration">{duration}</span>
        <CaretRight size={13} className={expanded ? "turned" : ""} />
      </button>
      {expanded && <div className="conv-step-detail">{children}</div>}
    </div>
  );
}

function Approval({
  request,
  answer,
  onDecision,
  disabled = false,
  stopPhase,
}) {
  const [decision, setDecision] = useState(
    answer ? (answer === "reject" ? "rejected" : "approved") : null,
  );
  const [count, setCount] = useState(5);
  useEffect(() => {
    setDecision(
      answer ? (answer === "reject" ? "rejected" : "approved") : null,
    );
    setCount(5);
  }, [answer]);
  useEffect(() => {
    if (decision !== "remember" || disabled) return;
    if (count === 0) {
      if (onDecision(request.id, "remember") !== false) setDecision("approved");
      return;
    }
    const timer = setTimeout(() => setCount((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [count, decision, disabled, onDecision, request.id]);
  if (decision === "approved" || decision === "rejected")
    return (
      <div
        className={`conv-decision ${decision === "rejected" ? "rejected" : ""}`}
      >
        {decision === "approved" ? (
          <CheckCircle size={16} />
        ) : (
          <XCircle size={16} />
        )}{" "}
        {decision === "approved" ? "已批准" : "已拒绝"} · {request.title}
      </div>
    );
  return (
    <section className="conv-approval">
      <div className="conv-card-label">
        <Badge tone="amber">
          {stopPhase === "waiting"
            ? "等待停止确认"
            : stopPhase === "unknown"
              ? "停止结果未确认"
              : "需要批准"}
        </Badge>
        <span>{request.kind === "file" ? "文件修改" : "运行命令"}</span>
      </div>
      <h3>{request.title}</h3>
      <p>{request.description}</p>
      <div className="conv-request">
        <span>
          {request.kind === "file" ? (
            <FileText size={17} />
          ) : (
            <TerminalWindow size={17} />
          )}
        </span>
        <code>{request.detail}</code>
      </div>
      <div className="conv-scope">
        <LockKey size={14} />
        <span>{request.scope}</span>
      </div>
      {decision === "remember" ? (
        <div className="conv-undo">
          <Clock size={16} />
          <span>
            {disabled
              ? "正在停止，批准尚未提交"
              : `${count} 秒后提交批准并记住`}
          </span>
          <Button
            onClick={() => {
              setDecision(null);
              setCount(5);
            }}
          >
            撤销
          </Button>
        </div>
      ) : (
        <div className="conv-approval-actions">
          <Button
            primary
            disabled={disabled}
            onClick={() => {
              if (onDecision(request.id, "once") !== false)
                setDecision("approved");
            }}
          >
            批准这一次
          </Button>
          {request.remember && (
            <Button
              disabled={disabled}
              onClick={() => {
                setCount(5);
                setDecision("remember");
              }}
            >
              批准并记住
            </Button>
          )}
          <Button
            kind="text"
            disabled={disabled}
            onClick={() => {
              if (onDecision(request.id, "reject") !== false)
                setDecision("rejected");
            }}
          >
            拒绝
          </Button>
        </div>
      )}
      {request.remember && (
        <small className="conv-card-foot">
          记住的范围由 Agent 提供，仅对上面写明的操作生效。
        </small>
      )}
    </section>
  );
}

function ArtifactDrawer({
  task,
  onTaskChange,
  onClose,
  initialTab = "files",
  initialFile = 0,
  toast,
  available = false,
  status,
  simulated = false,
  plan = false,
  scenario = null,
}) {
  const [tab, setTab] = useState(initialTab);
  const [showFileList, setShowFileList] = useState(false);
  const [file, setFile] = useState(initialFile);
  const [width, setWidth] = useState(510);
  const [view, setView] = useState("diff");
  const [logFilter, setLogFilter] = useState("全部");
  const paneRef = useRef(null);
  useEffect(() => {
    setTab(initialTab);
    setFile(initialFile);
  }, [initialTab, initialFile]);
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast?.("已复制到剪贴板");
    } catch {
      toast?.("无法复制，请选择文字后复制");
    }
  };
  const drag = (event) => {
    event.preventDefault();
    const startX = event.clientX,
      startWidth = width;
    const move = (e) =>
      setWidth(Math.min(760, Math.max(360, startWidth + startX - e.clientX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const artifactFiles = scenario?.files || FILES;
  const baseFile = artifactFiles[file] || artifactFiles[0];
  const current =
    baseFile && task?.artifactVersions?.[baseFile.path]
      ? {
          ...baseFile,
          lines: [
            ["add", "第二版示例：已调整内容，原行位置需重新核对。"],
            ...baseFile.lines,
          ],
        }
      : baseFile;
  const filePhase = task?.filePreviewStates?.[current?.path];
  const fileBlocked = filePhase && filePhase !== "ready";
  const versionLabel = task?.artifactVersions?.[current?.path]
    ? "第二版示例内容"
    : "第一版示例内容";
  const hasFiles = available && Boolean(current);
  const mode = tab === "files" && !scenario ? `files-${view}` : tab;
  const content = (current?.lines || [])
    .filter(([kind]) => kind !== "del")
    .map(([, text]) => text)
    .join("\n");
  const visibleLogs = scenario
    ? [
        {
          time: "刚刚",
          kind: "整理",
          text: available
            ? "已整理示例内容，可以继续确认和修改。"
            : "等待你的确认，尚未继续整理。",
        },
      ]
    : available
      ? LOGS
      : simulated || plan
        ? [
            {
              time: "刚刚",
              kind: "演示",
              text: plan
                ? "展示设计方案，尚未修改文件或执行测试。"
                : "这里只模拟消息状态，没有连接 Agent 或执行项目操作。",
            },
          ]
        : status === "unknown"
          ? [
              {
                time: "刚刚",
                kind: "停止",
                text: "停止请求已发出，尚未收到确认。",
              },
              {
                time: "此前",
                kind: "执行",
                text: "最后收到的状态为任务进行中。",
              },
            ]
          : [
              {
                time: "刚刚",
                kind: "等待",
                text:
                  status === "approval"
                    ? "等待你批准，修改与测试尚未执行。"
                    : status === "question"
                      ? "等待你的回答，尚未继续执行。"
                      : status === "stopped"
                        ? "任务已停止，未收到本轮产物。"
                        : "任务进行中，尚未收到完成结果。",
              },
            ];
  return (
    <aside
      ref={paneRef}
      className="conv-artifacts conv-legacy-artifacts"
      aria-label="会话产物"
      style={{ width }}
    >
      <div
        className="conv-resize"
        role="separator"
        tabIndex={0}
        aria-label="调整产物窗格宽度"
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={760}
        aria-valuenow={width}
        onPointerDown={drag}
        onKeyDown={(e) => {
          if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            setWidth((v) =>
              Math.min(
                760,
                Math.max(360, v + (e.key === "ArrowLeft" ? 20 : -20)),
              ),
            );
          }
        }}
      />
      <header className="conv-pane-head">
        <div className="conv-artifact-heading">
          <FileText size={18} />
          <h2>内容</h2>
          {hasFiles && <Badge>{artifactFiles.length}</Badge>}
        </div>
        <div className="conv-artifact-head-actions">
          <label className="conv-artifact-select conv-artifact-mode">
            <select
              aria-label="内容查看模式"
              value={mode}
              onChange={(event) => {
                const next = event.target.value;
                if (next.startsWith("files-")) {
                  setTab("files");
                  setView(next.slice(6));
                } else setTab(next);
              }}
            >
              {scenario ? (
                <option value="files">文稿内容</option>
              ) : (
                <>
                  <option value="files-diff">文件改动</option>
                  <option value="files-after">修改后的文件</option>
                  <option value="terminal">终端输出</option>
                </>
              )}
              <option value="logs">活动记录</option>
            </select>
            <CaretDown size={12} />
          </label>
          {tab === "terminal" && available && (
            <Button
              kind="icon"
              aria-label="复制输出"
              title="复制输出"
              onClick={() => copy(TERMINAL)}
            >
              <Copy size={16} />
            </Button>
          )}
          {tab === "logs" && (
            <Button
              kind="icon"
              aria-label="复制活动记录"
              title="复制活动记录"
              onClick={() =>
                copy(
                  visibleLogs
                    .map((x) => `${x.time} ${x.kind} ${x.text}`)
                    .join("\n"),
                )
              }
            >
              <Copy size={16} />
            </Button>
          )}
          <Button kind="icon" aria-label="关闭产物" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>
      </header>
      {(!available || (tab === "files" && !current)) && tab !== "logs" && (
        <div className="conv-pane-empty">
          <FileText size={30} />
          <strong>
            {status === "approval"
              ? "批准后才会继续执行"
              : "还没有可查看的产物"}
          </strong>
          <p>
            {simulated || plan
              ? "本次只展示模拟回复，没有生成文件或执行命令。"
              : status === "approval"
                ? "文件改动与测试结果会在 Agent 完成操作后出现。"
                : "已收到的活动信息可以在活动记录中查看。"}
          </p>
          <Button onClick={() => setTab("logs")}>查看活动记录</Button>
        </div>
      )}
      {tab === "files" && hasFiles && (
        <>
          <div className="conv-artifact-file-tools">
            <label className="conv-artifact-select conv-artifact-file-select">
              <select
                aria-label="选择查看的文件"
                title={current.path}
                value={artifactFiles.indexOf(baseFile)}
                onChange={(event) => {
                  setFile(Number(event.target.value));
                  setShowFileList(false);
                }}
              >
                {artifactFiles.map((item, i) => (
                  <option key={item.path} value={i}>
                    {item.path}
                    {!scenario
                      ? ` · +${item.adds}${item.dels > 0 ? ` −${item.dels}` : ""}`
                      : ""}
                  </option>
                ))}
              </select>
              <CaretDown size={12} />
            </label>
            <Button
              kind="icon"
              aria-label="复制文件路径"
              title="复制文件路径"
              onClick={() => copy(current.path)}
            >
              <Copy size={16} />
            </Button>
            <Button
              kind="text"
              aria-label={
                !scenario && view === "diff" ? "复制文件改动" : "复制文件内容"
              }
              onClick={() =>
                copy(
                  !scenario && view === "diff"
                    ? current.lines
                        .map(
                          ([kind, text]) =>
                            (kind === "add"
                              ? "+"
                              : kind === "del"
                                ? "-"
                                : " ") + text,
                        )
                        .join("\n")
                    : content,
                )
              }
            >
              复制
            </Button>
          </div>
          <div className="cr-file-version">
            <span>{versionLabel}</span>
            <Button kind="text" onClick={() => setShowFileList(!showFileList)}>
              文件列表
            </Button>
          </div>
          {showFileList ? (
            <div className="cr-file-list" aria-label="文件列表">
              {artifactFiles.map((item, index) => (
                <button
                  key={item.path}
                  onClick={() => {
                    setFile(index);
                    setShowFileList(false);
                  }}
                >
                  {item.path}
                </button>
              ))}
            </div>
          ) : fileBlocked ? (
            <FilePreviewState
              task={task}
              file={current}
              onTaskChange={onTaskChange}
              onBack={() => setShowFileList(true)}
            />
          ) : scenario ? (
            <article className="conv-artifact-document">
              {content
                .split("\n")
                .map((line, index) =>
                  line.startsWith("# ") ? (
                    <h2 key={index}>{line.slice(2)}</h2>
                  ) : (
                    <p key={index}>{line || "\u00a0"}</p>
                  ),
                )}
            </article>
          ) : (
            <div
              className="conv-diff"
              aria-label={view === "diff" ? "文件改动" : "修改后的文件"}
            >
              {current.lines
                .filter(([kind]) => view === "diff" || kind !== "del")
                .map(([kind, text], i) => (
                  <div
                    className={`conv-diff-line ${view === "diff" ? kind : "ctx"}`}
                    key={`${file}-${i}`}
                  >
                    <span className="conv-line-number">{i + 1}</span>
                    <span className="conv-line-sign">
                      {view === "diff"
                        ? kind === "add"
                          ? "+"
                          : kind === "del"
                            ? "−"
                            : " "
                        : " "}
                    </span>
                    <code>{text || " "}</code>
                  </div>
                ))}
            </div>
          )}
          {task && !fileBlocked && !showFileList && (
            <FileFeedback
              task={task}
              file={{
                path: current.path,
                content,
                versionLabel,
              }}
              onTaskChange={onTaskChange}
              toast={toast}
            />
          )}
          <FilePreviewReview
            task={task}
            file={current}
            onTaskChange={onTaskChange}
          />
          <footer className="conv-pane-note">
            {scenario
              ? "这是可继续讨论的示例内容，尚未写入你的文件。"
              : "示例文件改动，未写入真实文件。意见对应当前展示版本。"}
          </footer>
        </>
      )}
      {tab === "terminal" && available && (
        <>
          <div className="conv-terminal-summary">
            <div>
              <strong>项目卡片测试</strong>
              <small>执行结束 · 退出码 0 · 1.24 秒</small>
            </div>
            <Badge tone="green">通过</Badge>
          </div>
          <pre className="conv-terminal">{TERMINAL}</pre>
          <footer className="conv-pane-note">
            这里展示命令输出，不能直接输入或执行命令。
          </footer>
        </>
      )}
      {tab === "logs" && (
        <>
          <div className="conv-artifact-log-tools">
            <label className="conv-artifact-select">
              <select
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                aria-label="筛选活动记录"
              >
                <option value="全部">全部活动</option>
                {[...new Set(visibleLogs.map((x) => x.kind))].map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
              <CaretDown size={12} />
            </label>
          </div>
          <div className="conv-log-list">
            {visibleLogs
              .filter((x) => logFilter === "全部" || x.kind === logFilter)
              .map((x) => (
                <div key={x.time}>
                  <time>{x.time}</time>
                  <Badge>{x.kind}</Badge>
                  <p>{x.text}</p>
                </div>
              ))}
          </div>
          <footer className="conv-pane-note">
            本页只显示此对话中 Agent 提供的活动信息。
          </footer>
        </>
      )}
    </aside>
  );
}

export {
  FILES,
  TERMINAL,
  INITIAL_APPROVALS,
  normalQueue,
  normalMessages,
  isPresetTask,
  hasPresetResults,
  SentAttachments,
  SimulationResult,
  projectName,
  Step,
  Approval,
  ArtifactDrawer,
};
