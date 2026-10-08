import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowsInSimple,
  ArrowsOutSimple,
  CaretRight,
  ChatCircleText,
  CheckCircle,
  Code,
  Copy,
  Desktop,
  FileText,
  Globe,
  Rows,
  SquareHalf,
  TerminalWindow,
  WarningCircle,
  X,
  XCircle,
} from "@phosphor-icons/react";
import { Badge, Button } from "./ui";
import "./workspace.css";
import FileFeedback from "./FileFeedback.jsx";
import FilePreviewState, { FilePreviewReview } from "./FilePreviewState.jsx";

export function diffRows(before, after) {
  const left = before.split("\n"),
    right = after.split("\n");
  const matches = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      matches[i][j] =
        left[i] === right[j]
          ? matches[i + 1][j + 1] + 1
          : Math.max(matches[i + 1][j], matches[i][j + 1]);
  let i = 0,
    j = 0;
  const rows = [];
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({
        kind: "context",
        oldLine: i + 1,
        newLine: j + 1,
        before: left[i++],
        after: right[j++],
      });
    } else if (
      j < right.length &&
      (i === left.length || matches[i][j + 1] > matches[i + 1][j])
    )
      rows.push({ kind: "add", newLine: j + 1, before: "", after: right[j++] });
    else
      rows.push({
        kind: "remove",
        oldLine: i + 1,
        before: left[i++],
        after: "",
      });
  }
  return rows;
}
function MarkdownPreview({ text }) {
  return (
    <article className="workspace-document">
      {text
        .split("\n")
        .map((line, index) =>
          line.startsWith("# ") ? (
            <h1 key={index}>{line.slice(2)}</h1>
          ) : line.startsWith("## ") ? (
            <h2 key={index}>{line.slice(3)}</h2>
          ) : line ? (
            <p key={index}>{line}</p>
          ) : null,
        )}
    </article>
  );
}
function CodeView({ file, mode, focusLine }) {
  const rows = diffRows(file.before, file.after);
  if (mode === "source")
    return (
      <div className="workspace-code" aria-label="文件源码">
        {file.after.split("\n").map((line, index) => (
          <div
            key={index}
            data-workspace-line={index + 1}
            className={`workspace-code-line ${focusLine === index + 1 ? "is-focused" : ""}`}
          >
            <span>{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
    );
  return (
    <div
      className={`workspace-diff ${mode === "split" ? "split" : "unified"}`}
      aria-label={mode === "split" ? "并排差异" : "统一差异"}
    >
      {mode === "split" && (
        <div className="workspace-diff-head">
          <span>修改前</span>
          <span>修改后</span>
        </div>
      )}
      {file.before === file.after && (
        <p className="workspace-unchanged">
          此文件没有改动，保留为审阅上下文。
        </p>
      )}
      {rows.map((row, index) => (
        <div
          key={index}
          data-workspace-line={row.newLine}
          className={`workspace-diff-row ${row.kind} ${focusLine && row.newLine === focusLine ? "is-focused" : ""}`}
        >
          {mode === "split" ? (
            <>
              <div className="workspace-diff-cell">
                <span>{row.oldLine || ""}</span>
                <code>{row.before || " "}</code>
              </div>
              <div className="workspace-diff-cell">
                <span>{row.newLine || ""}</span>
                <code>{row.after || " "}</code>
              </div>
            </>
          ) : (
            <>
              <span className="workspace-old-line">{row.oldLine || ""}</span>
              <span className="workspace-new-line">{row.newLine || ""}</span>
              <b>
                {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
              </b>
              <code>
                {(row.kind === "remove" ? row.before : row.after) || " "}
              </code>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export default function WorkspacePanel({
  task,
  onTaskChange,
  kind,
  data,
  panel,
  onPanelChange,
  onClose,
  onFeedback,
  toast,
}) {
  data = {
    ...data,
    files: data?.files || [],
    findings: data?.findings || [],
    tests: data?.tests || [],
    logs: data?.logs || [],
  };
  const [width, setWidth] = useState(510),
    [diffMode, setDiffMode] = useState("unified"),
    [viewport, setViewport] = useState("wide"),
    [testFilter, setTestFilter] = useState("all"),
    [logFilter, setLogFilter] = useState("all");
  const [showFileList, setShowFileList] = useState(false);
  const contentRef = useRef(null),
    paneRef = useRef(null),
    previewRef = useRef(null);
  const defaults = {
    review: "diff",
    web: "preview",
    document: "compare",
    run: "tests",
  };
  const tab = panel.tab || defaults[kind],
    baseFile = data.files.find((item) => item.id === panel.file) ||
      data.files[0] || { id: "empty", path: "暂无文件", before: "", after: "" };
  const newerVersion = Boolean(task?.artifactVersions?.[baseFile.path]);
  const file = {
    ...baseFile,
    versionLabel: newerVersion ? "第二版示例内容" : "第一版示例内容",
    after: newerVersion
      ? `// 第二版示例：已调整内容，原行位置不再直接适用\n${baseFile.after}`
      : baseFile.after,
  };
  const filePhase = task?.filePreviewStates?.[file.path];
  const fileBlocked = filePhase && filePhase !== "ready";
  const visibleTests =
    data.tests?.filter(
      (test) => testFilter === "all" || test.status === "failed",
    ) || [];
  const selectedTest =
    visibleTests.find((test) => test.id === panel.test) ||
    visibleTests.find((test) => test.status === "failed") ||
    visibleTests[0];
  const finding = data.findings.find((item) => item.id === panel.finding);
  const change = (patch) => {
    setShowFileList(false);
    onPanelChange({ ...panel, ...patch });
  };
  const tabs = {
    review: [
      { id: "diff", label: "改动" },
      { id: "source", label: "源码" },
    ],
    web: [
      { id: "preview", label: "网页预览" },
      { id: "source", label: "源码" },
    ],
    document: [
      { id: "compare", label: "前后对照" },
      { id: "preview", label: "文稿预览" },
      { id: "source", label: "源码" },
    ],
    run: [
      { id: "tests", label: "测试结果" },
      { id: "logs", label: "完整输出" },
      { id: "source", label: "相关文件" },
    ],
  }[kind];
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast?.("已复制示例内容");
    } catch {
      toast?.("无法复制，请选择文字后复制");
    }
  };
  useEffect(() => {
    if (!panel.line) return;
    const frame = requestAnimationFrame(() =>
      contentRef.current
        ?.querySelector(`[data-workspace-line="${panel.line}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [panel.file, panel.line, panel.focusTick, tab, diffMode]);
  const drag = (event) => {
    event.preventDefault();
    const startX = event.clientX,
      startWidth = paneRef.current.getBoundingClientRect().width;
    const move = (next) => {
      const max = Math.max(
        380,
        (paneRef.current?.parentElement.clientWidth || 900) - 350,
      );
      setWidth(
        Math.min(max, Math.max(380, startWidth + startX - next.clientX)),
      );
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    if (panel.expanded) change({ expanded: false });
  };
  const isCode = tab === "diff" || tab === "source";
  const html = data.files.find((item) => item.language === "html")?.after || "";
  const css = data.files.find((item) => item.language === "css")?.after || "";
  const srcDoc = `<!doctype html><html lang="zh-CN" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><style>${css}</style></head><body>${html}</body></html>`;
  return (
    <aside
      ref={paneRef}
      className={`conv-artifacts workspace-panel ${panel.expanded ? "expanded" : ""}`}
      aria-label={data.label + "内容区"}
      style={{ width: panel.expanded ? "min(760px, 62%)" : width }}
    >
      <div
        className="conv-resize"
        role="separator"
        aria-label="调整内容区宽度"
        aria-orientation="vertical"
        aria-valuemin={380}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            setWidth((value) =>
              Math.min(
                740,
                Math.max(380, value + (event.key === "ArrowLeft" ? 24 : -24)),
              ),
            );
          }
        }}
      />
      <header className="conv-pane-head workspace-header">
        <div className="workspace-pane-heading">
          <h2>{data.label}</h2>
          <select
            aria-label="查看模式"
            value={tab}
            onChange={(event) => change({ tab: event.target.value })}
          >
            {tabs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="workspace-pane-actions">
          <Button
            kind="icon"
            title={panel.expanded ? "还原内容区宽度" : "扩宽内容区"}
            aria-label={panel.expanded ? "还原内容区宽度" : "扩宽内容区"}
            onClick={() => change({ expanded: !panel.expanded })}
          >
            {panel.expanded ? (
              <ArrowsInSimple size={17} />
            ) : (
              <ArrowsOutSimple size={17} />
            )}
          </Button>
          <Button
            kind="icon"
            title="关闭内容区"
            aria-label="关闭内容区"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </div>
      </header>
      {(isCode || kind === "document") && data.files.length > 0 && (
        <div className="workspace-toolbar workspace-code-tools">
          <label className="workspace-file-picker" title={file.path}>
            <FileText size={14} />
            <select
              aria-label="选择当前文件"
              title={file.path}
              value={file.id}
              onChange={(event) =>
                change({ file: event.target.value, line: null, finding: null })
              }
            >
              {data.files.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.path}
                </option>
              ))}
            </select>
          </label>
          {tab === "diff" && (
            <div className="conv-segment" aria-label="差异布局">
              <button
                title="统一查看差异"
                aria-pressed={diffMode === "unified"}
                className={diffMode === "unified" ? "active" : ""}
                onClick={() => setDiffMode("unified")}
              >
                <Rows size={13} />
                统一
              </button>
              <button
                title="并排查看差异"
                aria-pressed={diffMode === "split"}
                className={diffMode === "split" ? "active" : ""}
                onClick={() => setDiffMode("split")}
              >
                <SquareHalf size={13} />
                并排
              </button>
            </div>
          )}
          <Button
            kind="icon"
            title="复制当前文件"
            aria-label="复制当前文件"
            onClick={() => copy(file.after)}
          >
            <Copy size={15} />
          </Button>
        </div>
      )}
      {kind === "web" && tab === "preview" && (
        <div className="workspace-toolbar workspace-preview-tools">
          <span className="workspace-tool-caption">显示宽度</span>
          <div className="conv-segment">
            <button
              aria-pressed={viewport === "wide"}
              className={viewport === "wide" ? "active" : ""}
              onClick={() => setViewport("wide")}
            >
              <Desktop size={14} />
              自适应
            </button>
            <button
              aria-pressed={viewport === "narrow"}
              className={viewport === "narrow" ? "active" : ""}
              onClick={() => setViewport("narrow")}
            >
              390 px
            </button>
          </div>
        </div>
      )}
      {kind === "run" && tab === "tests" && (
        <div className="workspace-toolbar workspace-test-tools">
          <span className="workspace-test-counts">
            <strong>{data.tests.length} 项</strong>
            <span className="passed">
              {data.tests.filter((test) => test.status === "passed").length}{" "}
              通过
            </span>
            <span className="failed">
              {data.tests.filter((test) => test.status === "failed").length}{" "}
              失败
            </span>
          </span>
          <select
            aria-label="筛选测试结果"
            value={testFilter}
            onChange={(event) => setTestFilter(event.target.value)}
          >
            <option value="all">全部检查</option>
            <option value="failed">只看失败</option>
          </select>
        </div>
      )}
      {kind === "run" && tab === "logs" && (
        <div className="workspace-toolbar workspace-log-tools">
          <select
            aria-label="筛选运行输出"
            value={logFilter}
            onChange={(event) => setLogFilter(event.target.value)}
          >
            <option value="all">全部输出</option>
            <option value="error">仅错误</option>
          </select>
          <Button
            kind="icon"
            title="复制输出"
            aria-label="复制输出"
            onClick={() =>
              copy(
                data.logs
                  .map((log) => `${log.time} [${log.level}] ${log.text}`)
                  .join("\n"),
              )
            }
          >
            <Copy size={15} />
          </Button>
        </div>
      )}
      {task && !["logs", "tests"].includes(tab) && (
        <div className="cr-file-version">
          <span>{file.versionLabel}</span>
          <Button kind="text" onClick={() => setShowFileList(!showFileList)}>
            文件列表
          </Button>
        </div>
      )}
      <div
        className={`workspace-panel-content ${tab === "preview" && kind === "web" ? "web" : ""}`}
        ref={contentRef}
      >
        {showFileList ? (
          <div className="cr-file-list" aria-label="文件列表">
            {data.files.map((item) => (
              <button key={item.id} onClick={() => change({ file: item.id })}>
                {item.path}
                <small>
                  {" "}
                  ·{" "}
                  {task?.filePreviewStates?.[item.path] === "failed"
                    ? "上次读取失败，可重试"
                    : "可查看"}
                </small>
              </button>
            ))}
          </div>
        ) : fileBlocked && !["logs", "tests"].includes(tab) ? (
          <FilePreviewState
            task={task}
            file={file}
            onTaskChange={onTaskChange}
            onBack={() => setShowFileList(true)}
          />
        ) : (
          <>
            {isCode && finding && (
              <div className="workspace-location" role="note">
                <WarningCircle size={15} />
                <span>
                  {finding.title} · 第 {finding.line} 行
                </span>
                <Button kind="text" onClick={() => onFeedback(finding.prompt)}>
                  带回输入
                </Button>
              </div>
            )}
            {!data.files.length && (
              <div className="conv-pane-empty">
                <FileText size={28} />
                <strong>暂无可查看的内容</strong>
                <p>这份示例暂时没有文件。你可以关闭内容区，继续查看对话。</p>
                <Button onClick={onClose}>返回对话</Button>
              </div>
            )}
            {data.files.length > 0 && isCode && (
              <CodeView
                file={file}
                mode={tab === "source" ? "source" : diffMode}
                focusLine={panel.line}
              />
            )}
            {data.files.length > 0 && kind === "web" && tab === "preview" && (
              <>
                <div className={`workspace-web-stage ${viewport}`}>
                  <iframe
                    ref={previewRef}
                    sandbox=""
                    title="周末小计划 · 本地网页预览"
                    srcDoc={srcDoc}
                  />
                </div>
              </>
            )}
            {data.files.length > 0 &&
              kind === "document" &&
              tab === "compare" && (
                <div className="workspace-document-compare">
                  <section>
                    <header>原稿</header>
                    <MarkdownPreview text={file.before} />
                  </section>
                  <section>
                    <header>修改稿</header>
                    <MarkdownPreview text={file.after} />
                  </section>
                </div>
              )}
            {data.files.length > 0 &&
              kind === "document" &&
              tab === "preview" && <MarkdownPreview text={file.after} />}
            {data.files.length > 0 && kind === "run" && tab === "tests" && (
              <>
                <div className="workspace-test-list">
                  {visibleTests.map((test) => (
                    <button
                      key={test.id}
                      className={selectedTest?.id === test.id ? "selected" : ""}
                      onClick={() => change({ test: test.id })}
                    >
                      {test.status === "passed" ? (
                        <CheckCircle size={16} className="passed" />
                      ) : (
                        <XCircle size={16} className="failed" />
                      )}
                      <span>{test.name}</span>
                      <small>{test.duration}</small>
                      <CaretRight size={13} />
                    </button>
                  ))}
                </div>
                {selectedTest && (
                  <section className="workspace-test-detail">
                    <h3>{selectedTest.name}</h3>
                    <pre>{selectedTest.detail}</pre>
                    <Button
                      onClick={() =>
                        change({
                          tab: "source",
                          file: selectedTest.fileId,
                          line: selectedTest.line,
                          focusTick: Date.now(),
                        })
                      }
                    >
                      查看相关代码
                      <ArrowLeft size={13} />
                    </Button>
                    {selectedTest.status === "failed" && (
                      <Button
                        kind="text"
                        onClick={() =>
                          onFeedback(
                            `请分析这条测试失败：${selectedTest.name}。${selectedTest.detail.split("\n")[0]}。先讨论原因与修复方案，不要直接修改。`,
                          )
                        }
                      >
                        <ChatCircleText size={14} />
                        带回输入
                      </Button>
                    )}
                  </section>
                )}
              </>
            )}
            {data.files.length > 0 && kind === "run" && tab === "logs" && (
              <>
                <div className="workspace-log-list">
                  {data.logs
                    .filter(
                      (log) => logFilter === "all" || log.level === logFilter,
                    )
                    .map((log, index) => (
                      <div className={log.level} key={index}>
                        <time>{log.time}</time>
                        <span>{log.level}</span>
                        <code>{log.text}</code>
                      </div>
                    ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {task &&
        data.files.length > 0 &&
        !fileBlocked &&
        !showFileList &&
        !["logs", "tests"].includes(tab) && (
          <FileFeedback
            task={task}
            file={file}
            onTaskChange={onTaskChange}
            toast={toast}
          />
        )}
      {task && !["logs", "tests"].includes(tab) && (
        <FilePreviewReview
          task={task}
          file={file}
          onTaskChange={onTaskChange}
        />
      )}
      <footer className="workspace-pane-footer">
        <span>
          {tab === "diff"
            ? "本地示例：原稿 → 修改稿，未写入文件"
            : kind === "web"
              ? "本地网页，无外部请求"
              : kind === "run"
                ? "本地输出样例 · 退出码 1，未重新执行"
                : "只读样例，没有修改真实文件"}
        </span>
        {kind === "document" && (
          <Button
            kind="text"
            onClick={() =>
              onFeedback(
                "请继续调整这份介绍文稿：保留具体例子，把篇幅再压缩一些。先给我修改建议。",
              )
            }
          >
            反馈到输入
            <ChatCircleText size={13} />
          </Button>
        )}
      </footer>
    </aside>
  );
}
