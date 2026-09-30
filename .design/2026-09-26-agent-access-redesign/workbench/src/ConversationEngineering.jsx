import React from "react";
import {
  ArrowUpRight,
  CaretRight,
  CheckCircle,
  Copy,
  FileText,
  FolderSimple,
  PencilSimple,
  TerminalWindow,
} from "@phosphor-icons/react";
import { Button } from "./ui";
import { FILES, TERMINAL, Step } from "./ConversationParts.jsx";
import { ProgressSummary } from "./ConversationScenarios.jsx";
export function EngineeringSteps({
  pending,
  resultsAvailable,
  blocked,
  stepWait,
  isRunning,
  openPane,
}) {
  return (
    <ProgressSummary
      text={
        pending
          ? "已阅读文件，等待你确认"
          : resultsAvailable
            ? "已完成修改与检查"
            : "查看处理过程"
      }
    >
      <Step
        title="查看项目结构"
        detail="项目卡片、样式与现有测试"
        duration={blocked ? "历史记录" : "2.1 秒"}
        icon={FolderSimple}
      >
        <p>读取了 3 个相关文件，已有组件使用统一的间距与颜色。</p>
        <span>src/components/ProjectCard.tsx</span>
      </Step>
      <Step
        title="更新卡片交互"
        detail="点击、键盘 Enter、可见焦点"
        duration={resultsAvailable ? "3.8 秒" : stepWait}
        waiting={!resultsAvailable}
        icon={PencilSimple}
      >
        <p>
          {resultsAvailable
            ? "使用可聚焦的按钮语义，保留卡片布局，添加焦点样式。"
            : pending
              ? "尚未修改文件。收到你的决定后才会继续。"
              : "尚未收到这一步的完成确认。"}
        </p>
        {resultsAvailable && (
          <button
            type="button"
            className="conv-inline-link"
            onClick={() => openPane("files", 1)}
          >
            查看样式改动
            <ArrowUpRight size={13} />
          </button>
        )}
      </Step>
      <Step
        title={isRunning ? "检查相关测试" : "运行相关测试"}
        detail="npm run test -- ProjectCard"
        duration={
          resultsAvailable ? "1.24 秒" : isRunning ? "进行中" : stepWait
        }
        live={isRunning && !resultsAvailable}
        waiting={!resultsAvailable}
        icon={TerminalWindow}
      >
        {resultsAvailable ? (
          <>
            <pre>{TERMINAL}</pre>
            <Button kind="text" onClick={() => openPane("terminal")}>
              在产物中查看完整输出
              <ArrowUpRight size={13} />
            </Button>
          </>
        ) : (
          <p>
            {pending
              ? "尚未执行测试。批准后才会运行该命令。"
              : "尚未收到测试结果，不能确认是否通过。"}
          </p>
        )}
      </Step>
    </ProgressSummary>
  );
}
export function EngineeringResult({ simulated, openPane, copy }) {
  return (
    <section className="conv-result">
      <div className="conv-result-label">
        <CheckCircle size={20} weight="fill" />
        <strong>{simulated ? "此前的预设成果" : "预设完成示例"}</strong>
      </div>
      <h2>项目卡片交互已完善</h2>
      <p>保留原有布局，补充了键盘操作、焦点状态和相关测试。</p>
      <ul>
        <li>Tab 可以聚焦卡片，Enter 打开项目。</li>
        <li>焦点轮廓保持清晰，样式沿用现有颜色。</li>
        <li>4 项相关测试通过，其他部分未在本轮验证。</li>
      </ul>
      <div className="conv-result-files">
        {FILES.map((file, index) => (
          <button
            type="button"
            key={file.path}
            onClick={() => openPane("files", index)}
          >
            <FileText size={16} />
            <span>{file.label}</span>
            <span className="conv-diff-count">
              <b>+{file.adds}</b>
              {file.dels > 0 && <i>−{file.dels}</i>}
            </span>
            <ArrowUpRight size={14} />
          </button>
        ))}
      </div>
      <div className="conv-result-footer">
        <button type="button" onClick={() => openPane("terminal")}>
          <CheckCircle size={15} />4 项测试通过
          <CaretRight size={13} />
        </button>
        <Button
          kind="text"
          onClick={() =>
            copy("项目卡片交互已完善：键盘操作、焦点状态与 4 项相关测试。")
          }
        >
          <Copy size={14} />
          复制结果
        </Button>
      </div>
    </section>
  );
}
