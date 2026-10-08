import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  CaretDown,
  Check,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  Folder,
  Gear,
  Key,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Trash,
  X,
  WarningCircle,
  Bell,
  Keyboard,
  Monitor,
  Moon,
  Sun,
  BookOpen,
  Clock,
} from "@phosphor-icons/react";
import {
  Button,
  Badge,
  AgentIcon,
  PageHeading,
  Empty,
  Notice,
  Modal,
  Toggle,
  Field,
  Tabs,
} from "./ui.jsx";

import { ReviewScenario, Confirm, clone } from "./settings-ui.jsx";
import {
  autoArchiveEligibility,
  archiveEligibility,
} from "./history-policy.js";
import { conversationState } from "./conversation-policy.js";
import "./history-settings.css";
import "./settings-redesign.css";
import { DataPrivacy, DiagnosticExport } from "./settings-maintenance.jsx";

export function updatePreviewIssue({
  tasks = [],
  storageIssue = false,
  saveFailed = false,
} = {}) {
  if (storageIssue || saveFailed)
    return {
      kind: "storage",
      title: "请先保留未发送的内容",
      message: "当前保存失败。请先复制保留草稿，恢复本地保存后再继续。",
    };
  if (tasks.some((task) => !archiveEligibility(task).allowed))
    return {
      kind: "work",
      title: "请先处理以下工作",
      message: "安装会重启 Farfold。处理完成后，再回来检查。",
    };
  return null;
}

export default function General({
  theme,
  setTheme,
  toast = () => {},
  tasks = [],
  storageIssue = false,
  archiveDays = "30",
  onArchiveDaysChange,
  onRunArchive,
  onOpenArchived,
  onManageSending,
}) {
  const [localArchive, setLocalArchive] = useState(String(archiveDays));
  const archive = onArchiveDaysChange ? String(archiveDays) : localArchive;
  const setArchive = onArchiveDaysChange || setLocalArchive;
  const archiveCandidates = tasks.filter(
    (task) => autoArchiveEligibility(task, archive).allowed,
  );
  const updateBlockedTasks = tasks.filter(
    (task) => !archiveEligibility(task).allowed,
  );
  const [update, setUpdate] = useState(null);
  const [updateScenario, setUpdateScenario] = useState("unconfigured");
  const [diagnostic, setDiagnostic] = useState(null);
  const [shortcut, setShortcut] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [generalFail, setGeneralFail] = useState(false);
  const updateIssue = updatePreviewIssue({
    tasks,
    storageIssue,
    saveFailed: generalFail,
  });
  const updateTicket = useRef(0);
  useEffect(() => {
    if (updateIssue && update === "installed") setUpdate("busy-tasks");
  }, [updateIssue?.kind, update]);
  useEffect(
    () => () => {
      updateTicket.current++;
    },
    [],
  );
  const savePreference = (value, setter) => {
    if (generalFail) {
      toast("演示：保存失败，仍使用之前的设置");
      return;
    }
    setter(value);
    toast("演示设置已保存");
  };
  const checkUpdate = () => {
    const id = ++updateTicket.current;
    setUpdate("checking");
    setTimeout(() => {
      if (id === updateTicket.current) setUpdate(updateScenario);
    }, 900);
  };
  return (
    <div className="settings-redesign">
      <PageHeading
        title="通用"
        description="让 Farfold 适合你的日常工作方式。"
      />
      <nav className="sl-settings-index" aria-label="通用设置分组">
        <a href="#settings-appearance">外观</a>
        <a href="#settings-organisation">对话整理</a>
        <a href="#settings-maintenance">更新与诊断</a>
        <a href="#settings-data">数据与隐私</a>
      </nav>
      <section id="settings-appearance" className="set-general-section">
        <div className="set-section-title">
          <h3>外观</h3>
          <span>界面配色</span>
        </div>
        <div className="set-appearance">
          {[
            { id: "light", label: "浅色", icon: Sun },
            { id: "dark", label: "深色", icon: Moon },
            { id: "system", label: "跟随系统", icon: Monitor },
          ].map(({ id, label, icon: Icon }) => (
            <button
              className={`set-theme-card ${theme === id ? "selected" : ""}`}
              key={id}
              aria-pressed={theme === id}
              onClick={() => savePreference(id, setTheme)}
            >
              <span className={`set-theme-swatch ${id}`}>
                <i />
                <b />
                <em />
              </span>
              <span>
                <Icon size={17} />
                {label}
                {theme === id && <CheckCircle size={17} weight="fill" />}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section id="settings-organisation" className="set-general-section">
        <h3>工作与整理</h3>
        <div className="set-setting-row">
          <div>
            <strong>自动归档</strong>
            <p>
              将无活动的已结束对话移到“已归档”。收藏及有待处理内容的对话保留。
            </p>
          </div>
          <select
            aria-label="自动归档天数"
            value={archive}
            onChange={(e) => savePreference(e.target.value, setArchive)}
          >
            <option value="0">关闭</option>
            <option value="7">7 天无活动后</option>
            <option value="30">30 天无活动后</option>
            <option value="90">90 天无活动后</option>
          </select>
        </div>
        <div className="history-archive-details">
          <details>
            <summary>哪些对话会被自动归档？</summary>
            <ul>
              <li>
                从最后一次发送、回复结束或编辑未发内容开始计时。浏览、重命名和分组不会重置时间。
              </li>
              <li>
                运行、审批、提问、结果未知、提交或停止未确认、待发消息及未发送草稿都先保留。
              </li>
              <li>最后活动时间未知的旧对话不自动归档。</li>
              <li>重新打开、修改期限和持续使用时都会检查，无需手动整理。</li>
              <li>
                归档结果会保存，重启后保持；手动移回的对话重新等待完整的归档期限。
              </li>
            </ul>
          </details>
          <div className="history-archive-actions">
            <span>
              {Number(archive)
                ? `当前有 ${archiveCandidates.length} 段对话符合条件`
                : "自动归档已关闭，已归档的对话保持原位"}
            </span>
            <Button
              disabled={
                !Number(archive) || !archiveCandidates.length || !onRunArchive
              }
              onClick={() => {
                if (generalFail) {
                  toast("演示：归档保存失败，对话仍保留在原处");
                  return;
                }
                onRunArchive?.();
              }}
            >
              现在整理
            </Button>
            {onOpenArchived && (
              <Button kind="ghost" onClick={onOpenArchived}>
                查看已归档
              </Button>
            )}
          </div>
          <p className="history-proposal-note">
            此处演示保存到本浏览器的整理结果，不会改变正式应用中的对话。
          </p>
        </div>
        <div className="set-setting-row">
          <div>
            <strong>
              <Bell size={16} />
              需要你时提醒 <Badge>设计提案</Badge>
            </strong>
            <p>Agent 请求批准、提问或工作出现异常时，给出桌面提醒。</p>
          </div>
          <span className="set-caption">尚未提供</span>
        </div>
        <div className="set-setting-row">
          <div>
            <strong>
              提醒声音 <Badge>设计提案</Badge>
            </strong>
            <p>只对需要处理的事项播放声音，普通输出保持安静。</p>
          </div>
          <span className="set-caption">尚未提供</span>
        </div>
      </section>
      <section className="set-general-section">
        <div className="set-section-title">
          <h3>
            <Keyboard size={18} />
            快捷键
          </h3>
          <Button onClick={() => setShortcut(true)}>查看快捷键</Button>
        </div>
        <div className="set-shortcut-summary">
          <span>
            新对话 <kbd>⌘ N</kbd>
          </span>
          <span>
            搜索与命令 <kbd>⌘ K</kbd>
          </span>
          <span>
            设置 <kbd>⌘ ,</kbd>
          </span>
        </div>
      </section>
      <section id="settings-maintenance" className="set-general-section">
        <h3>更新与诊断</h3>
        <div className="set-setting-row">
          <div>
            <strong>Farfold 0.1.7</strong>
            <p>当前版本 · macOS</p>
          </div>
          <Button onClick={() => setUpdate("intro")}>检查更新</Button>
        </div>
        <div className="set-setting-row">
          <div>
            <strong>诊断记录</strong>
            <p>导出不含对话正文、密钥与项目内容的诊断信息。</p>
          </div>
          <Button onClick={() => setDiagnostic("scope")}>
            <DownloadSimple size={16} />
            预览与导出
          </Button>
        </div>
      </section>
      <section id="settings-data" className="set-general-section">
        <h3>数据与隐私</h3>
        <div className="set-setting-row">
          <div>
            <strong>你的数据如何保存</strong>
            <p>查看数据归属、清除范围与完整卸载步骤。</p>
          </div>
          <Button onClick={() => setPrivacy(true)}>
            查看说明 <ArrowRight size={15} />
          </Button>
        </div>
      </section>
      {onManageSending && (
        <section className="set-general-section">
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>
              高级
            </summary>
            <div className="set-setting-row">
              <div>
                <strong>暂停消息发送</strong>
                <p>按位置暂停新消息，不停止进行中的任务。</p>
              </div>
              <Button onClick={onManageSending}>管理</Button>
            </div>
          </details>
        </section>
      )}
      <details className="sl-demo-tools">
        <summary>原型状态选项</summary>
        <label className="set-review set-review-check">
          <input
            type="checkbox"
            checked={generalFail}
            onChange={(e) => setGeneralFail(e.target.checked)}
          />
          <span>演示设置保存失败</span>
          <small>验证原值保留与错误反馈</small>
        </label>
      </details>
      {update && (
        <Modal
          title="Farfold 更新"
          onClose={() => {
            updateTicket.current++;
            setUpdate(null);
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  updateTicket.current++;
                  setUpdate(null);
                }}
              >
                关闭
              </Button>
              {!["busy-tasks", "installed", "manual", "unconfigured"].includes(
                update,
              ) && (
                <Button
                  primary
                  disabled={update === "checking"}
                  onClick={checkUpdate}
                >
                  {update === "checking" ? "检查中…" : "检查更新"}
                </Button>
              )}
            </>
          }
        >
          <div className="set-version-head">
            <span className="set-app-mark">
              <Sparkle size={26} />
            </span>
            <div>
              <strong>Farfold</strong>
              <p>当前版本 0.1.7</p>
            </div>
          </div>
          <details className="sl-demo-tools">
            <summary>更新状态示例</summary>
            <ReviewScenario
              value={updateScenario}
              onChange={(v) => {
                updateTicket.current++;
                setUpdateScenario(v);
                setUpdate("intro");
              }}
              items={[
                ["unconfigured", "尚无发布通道"],
                ["available", "发现新版本"],
                ["current", "已是最新"],
                ["failed", "检查失败"],
              ]}
            />
          </details>
          {update === "intro" && (
            <p className="set-caption">
              点击检查后显示本次结果，不把“尚未检查”当成“已是最新”。
            </p>
          )}
          {update === "checking" && (
            <p className="set-note">
              <CircleNotch size={18} className="spin" />
              正在检查…
            </p>
          )}
          {update === "unconfigured" && (
            <Notice title="当前版本没有配置发布通道">
              此版本不会自动检查或下载公开更新。可从最初获取安装包的渠道确认发布信息。
              <Button onClick={() => setUpdate("manual")}>
                查看手动更新步骤
              </Button>
            </Notice>
          )}
          {update === "manual" && (
            <div className="sl-step-list">
              <h3>从原发布渠道获取更新</h3>
              <ol>
                <li>联系安装包提供方或回到原下载位置，核对版本与适用系统。</li>
                <li>保留草稿，结束进行中和结果未知的工作。</li>
                <li>
                  按发布方说明更新；应用设置与 Agent
                  数据的保留范围需在安装前确认。
                </li>
              </ol>
              <p>
                当前没有可验证的发布地址，因此原型不会打开外部链接或下载文件。
              </p>
              <Button onClick={() => setUpdate("intro")}>返回检查</Button>
            </div>
          )}
          {update === "failed" && (
            <Notice tone="warning" title="检查更新失败">
              请稍后重试。当前结果不能说明是否已有新版本。
            </Notice>
          )}
          {update === "current" && (
            <Notice tone="success" title="已是最新版本">
              这是本次检查的模拟结果。
            </Notice>
          )}
          {update === "available" && (
            <div className="set-update-release">
              <Badge tone="purple">模拟新版本</Badge>
              <h3>Farfold 0.1.8</h3>
              <p>改善任务状态反馈与设置体验。</p>
              <ul>
                <li>更清楚地查看需要处理的事项</li>
                <li>优化窄窗口中的对话与产物</li>
              </ul>
              <Button primary onClick={() => setUpdate("busy-tasks")}>
                查看安装影响
              </Button>
            </div>
          )}
          {update === "busy-tasks" && (
            <>
              <Notice
                tone={updateIssue ? "warning" : ""}
                title={updateIssue?.title || "可以预览安装结果"}
              >
                {updateIssue?.message ||
                  "已保存的未发内容会保留。这次只演示结果，不会下载或重启。"}
              </Notice>
              {updateBlockedTasks.length > 0 && (
                <div className="set-impact">
                  {updateBlockedTasks.map((task) => (
                    <p key={task.id}>
                      {task.title}{" "}
                      <Badge>
                        {conversationState(task).idle
                          ? "有待发消息"
                          : conversationState(task).label}
                      </Badge>
                    </p>
                  ))}
                </div>
              )}
              <div className="set-inline-actions">
                <Button onClick={() => setUpdate(null)}>稍后再说</Button>
                <Button
                  disabled={Boolean(updateIssue)}
                  onClick={() => {
                    if (updateIssue) return;
                    setUpdate("installed");
                    toast("演示：更新完成。实际应用未下载、安装或重启");
                  }}
                >
                  预览安装完成结果
                </Button>
              </div>
            </>
          )}
          {update === "installed" && (
            <Notice tone="success" title="更新完成的结果预览">
              正式产品会重新打开并恢复会话。此原型没有下载或安装任何内容。
            </Notice>
          )}
        </Modal>
      )}
      {diagnostic && <DiagnosticExport onClose={() => setDiagnostic(null)} />}
      {shortcut && (
        <Modal
          title="快捷键"
          onClose={() => setShortcut(false)}
          footer={
            <Button primary onClick={() => setShortcut(false)}>
              关闭
            </Button>
          }
        >
          <div className="set-shortcut-list">
            {[
              ["新对话", "⌘ N"],
              ["搜索与命令", "⌘ K"],
              ["打开设置", "⌘ ,"],
              ["关闭当前弹窗", "Esc"],
              ["发送消息", "Enter"],
              ["输入换行", "⇧ Enter"],
            ].map(([name, key]) => (
              <div key={name}>
                <span>{name}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {privacy && (
        <DataPrivacy
          onClose={() => setPrivacy(false)}
          blockedTasks={updateBlockedTasks}
          storageIssue={storageIssue || generalFail}
        />
      )}
    </div>
  );
}
