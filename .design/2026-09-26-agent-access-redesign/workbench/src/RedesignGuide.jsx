import React, { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Compass,
  ChatsCircle,
  FolderSimple,
  Gear,
  CheckCircle,
} from "@phosphor-icons/react";
import { Modal, Button } from "./ui";
import { REDESIGN_ISSUES, REDESIGN_FAMILIES } from "./redesign-map.js";

const journeys = [
  [
    "01",
    "从想法到第一条消息",
    "写草稿 → 选择 Agent → 确认服务与模型 → 选择工作文件夹 → 发送",
    "new",
    ChatsCircle,
  ],
  [
    "02",
    "接入和日常管理",
    "查看能力 → 程序准备 → 账号与服务 → 模型；已有接入直接管理",
    "agents",
    Compass,
  ],
  [
    "03",
    "推进一段工作",
    "审批 / 回答 → 待发管理 → 停止确认 → 恢复与权限复核",
    "approval",
    CheckCircle,
  ],
  [
    "04",
    "查看和修改成果",
    "文件 / 网页 → 核对版本和权限 → 给修改意见 → 回到原对话",
    "workspace",
    FolderSimple,
  ],
  [
    "05",
    "接续历史",
    "搜索 → 收藏与分组 → 带入已有对话 → 只读或明确继续",
    "conversations",
    ChatsCircle,
  ],
  [
    "06",
    "维护应用与服务",
    "API 配置 → 外观与提醒 → 诊断预览 → 数据范围与退出保护",
    "general",
    Gear,
  ],
];
export default function RedesignGuide({ onClose, onNavigate }) {
  const [tab, setTab] = useState("direction");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [boundary, setBoundary] = useState("");
  const visit = (target) => {
    if (["exit", "external"].includes(target)) {
      setBoundary(target);
      return;
    }
    onNavigate(target);
  };
  return (
    <Modal
      className="redesign-guide"
      title="Farfold · 全产品改版"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="guide-footer-note">
            设计原型 07 · 2026.10.09 · 真实能力仍需单独验证
          </span>
          <Button primary onClick={() => onNavigate("new")}>
            进入工作台 <ArrowRight size={15} />
          </Button>
        </>
      }
    >
      <nav className="guide-tabs" aria-label="改版导览章节">
        {[
          ["direction", "整体方向"],
          ["journeys", "完整流程"],
          ["issues", "问题对应"],
          ["coverage", "页面与边界"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "direction" && (
        <div className="guide-direction">
          <div className="guide-intro">
            <small>把精力留给正在做的事</small>
            <h2>
              更清楚地开始，
              <br />
              更放心地接续。
            </h2>
            <p>
              保留多 Agent
              共用的工作台。让日常操作轻一点，让关键决定有依据，让中断之后仍然找得到下一步。
            </p>
          </div>
          <div className="guide-principles">
            {[
              [
                "任务在前",
                "新对话是起点，草稿随导航保留。接入与设置完成后回到原任务。",
              ],
              [
                "上下文可见",
                "Agent、服务、工作位置与模型清楚配对；危险变更呈现改前、改后和影响范围。",
              ],
              [
                "状态有出口",
                "待回应、停止中、结果未知、只读和失败都有不同的动作，不用一个“重试”包办。",
              ],
              [
                "层级有节奏",
                "灰白底、深灰主动作、克制的状态色；常用操作优先，路径、版本与诊断明细按需展开。",
              ],
            ].map(([title, body], i) => (
              <article key={title}>
                <span>0{i + 1}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
          <Button onClick={() => setTab("journeys")}>
            按完整流程体验 <ArrowRight size={16} />
          </Button>
        </div>
      )}
      {tab === "journeys" && (
        <div className="guide-journeys">
          <p>
            从任何一条开始。对话与文件演示会补充示例，保留现有草稿和演示记录。
          </p>
          {journeys.map(([n, title, desc, target, Icon]) => (
            <button key={n} onClick={() => visit(target)}>
              <span className="journey-number">{n}</span>
              <Icon size={22} />
              <span>
                <strong>{title}</strong>
                <small>{desc}</small>
              </span>
              <ArrowUpRight size={20} />
            </button>
          ))}
        </div>
      )}
      {tab === "issues" && (
        <div className="guide-issues">
          <p>
            沿用审查编号：31 项已观察问题、19
            项待复验风险。这里列出设计应对，不能当作正式产品已经修复的记录。
          </p>
          <div className="guide-filter">
            <input
              aria-label="查找审查问题"
              placeholder="查找编号或关键词，例如 F05、来源"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              aria-label="审查结论类型"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">全部 50 项</option>
              <option value="observed">已观察问题</option>
              <option value="risk">待复验风险</option>
            </select>
          </div>
          {REDESIGN_ISSUES.filter(
            (x) =>
              (scope === "all" || x.status === scope) &&
              `${x.issueId} ${x.title} ${x.recommendation}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          ).map((x) => (
            <article key={x.issueId}>
              <header>
                <span>{x.issueId}</span>
                <small>{x.status === "observed" ? "已观察" : "待复验"}</small>
                <h3>{x.title}</h3>
              </header>
              <p>{x.recommendation}</p>
              <button onClick={() => visit(x.target)}>
                查看对应流程 <ArrowUpRight size={14} />
              </button>
            </article>
          ))}
        </div>
      )}
      {tab === "coverage" && (
        <div className="guide-coverage">
          <p>
            24
            类界面逐一对应入口。系统窗口与外部登录只说明交接要求，浏览器原型不能替代实机体验。
          </p>
          {REDESIGN_FAMILIES.map((x) => (
            <button key={x.id} onClick={() => visit(x.target)}>
              <small>{x.id}</small>
              <span>
                <strong>{x.title}</strong>
                <small>{x.path}</small>
              </span>
              <span className="coverage-kind">
                {["exit", "external"].includes(x.target)
                  ? "边界说明"
                  : "打开流程"}
              </span>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </div>
      )}
      {boundary && (
        <Modal
          title={
            boundary === "exit"
              ? "保存与退出的设计边界"
              : "系统与外部界面的交接"
          }
          onClose={() => setBoundary("")}
          footer={<Button onClick={() => setBoundary("")}>返回导览</Button>}
        >
          {boundary === "exit" ? (
            <>
              <p>退出前区分三种情况，不用一个笼统的确认框：</p>
              <ol className="boundary-list">
                <li>
                  <strong>内容已保存</strong>
                  <p>
                    直接退出；重新打开恢复草稿、工作位置和待发内容，不自动发送。
                  </p>
                </li>
                <li>
                  <strong>保存失败</strong>
                  <p>
                    保持应用打开，提供重试与复制草稿；明确哪些内容没有保存。
                  </p>
                </li>
                <li>
                  <strong>工作仍在进行或结果未知</strong>
                  <p>
                    列出具体对话和状态，允许返回；不把关窗口等同于停止 Agent。
                  </p>
                </li>
              </ol>
              <p>
                当前“重启演示”可体验保留与恢复。真实退出、进程停止与存储失败弹窗需进入正式实现后验证。
              </p>
            </>
          ) : (
            <>
              <p>
                系统文件选择、菜单栏、通知、剪贴板、外部登录和安装窗口沿用操作系统交互。原型中的文件夹、附件和登录都使用示例数据。
              </p>
              <ul className="boundary-list">
                <li>取消文件选择 → 返回原草稿，不清空内容。</li>
                <li>外部登录返回 → 自动检查真实登录结果，检查前不显示成功。</li>
                <li>通知点击 → 定位具体对话与待处理事项。</li>
                <li>窗口缩小 → 保留主动作和独立滚动，不能隐藏退出按钮。</li>
              </ul>
              <p>
                这些行为必须在目标系统重新验收，不能用网页中的演示回执替代。
              </p>
            </>
          )}
        </Modal>
      )}
    </Modal>
  );
}
