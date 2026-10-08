import React, { useState } from "react";
import {
  Plus,
  ArrowUp,
  CaretDown,
  SlidersHorizontal,
  Paperclip,
  FileText,
  FolderSimple,
  X,
  Check,
  Compass,
  AirplaneTilt,
  PencilLine,
  BookOpen,
  Globe,
} from "@phosphor-icons/react";
import { Button, AgentIcon, Modal, Badge } from "./ui";
import DraftWebPreview from "./DraftWebPreview.jsx";
import PermissionControl from "./PermissionControl.jsx";
import { permissionSelectionFor } from "./agent-catalog.js";
import { currentModelOptions } from "./model-read-state.js";
import { hasDraftContent } from "./workbench-state.js";
import {
  agentCanStartConversation,
  agentNeedsInitialPreparation,
} from "./agent-setup-state.js";
import { accountRequiredForSelection } from "./authentication-state.js";
import {
  hasPendingOnboarding,
  pendingOnboardingForEntry,
  selectionMatchesAgent,
} from "./setup-entry.js";
import {
  compatibleServices,
  serviceAccess,
  serviceChoiceIssue,
  usesApi,
} from "./service-access.js";
export default function NewConversationV2({
  draft,
  recoveryNotice = null,
  setDraft,
  choice,
  setChoice,
  agents,
  services,
  files,
  setFiles,
  folder,
  setFolder,
  onSend,
  onExplore,
  pending = false,
  sendError = "",
  workEnabled = true,
  onResumeSending,
  onManageServices,
  onChoiceChange,
  apiAuthBlocked = false,
}) {
  const [modal, setModal] = useState(null),
    [search, setSearch] = useState(""),
    [modelDraft, setModelDraft] = useState(null);
  const [pendingAgent, setPendingAgent] = useState(null);
  const [draftWeb, setDraftWeb] = useState(false);
  const current = agents.find((a) => selectionMatchesAgent(a, choice));
  const pendingPreparation =
    current &&
    pendingOnboardingForEntry(current, choice, { view: "new", folder });
  const ready = agentCanStartConversation(current) && !pendingPreparation;
  const permission = permissionSelectionFor(current, choice);
  const hasContent = hasDraftContent(draft, files);
  const existingModels = current
    ? currentModelOptions(current, {
        access: "existing",
        folder,
        serviceId: "",
      })
    : [];
  const selectedServiceIssue =
    usesApi(choice) && serviceChoiceIssue(choice, current, services);
  const selectable = agents.filter(
    (a) => a.added || a.connected || a.demoReady || a.setupComplete,
  );
  const compatible = compatibleServices(current, services);
  const modelIssue = modelDraft
    ? serviceChoiceIssue(modelDraft, current, services)
    : null;
  const chooseAgent = (a, confirmed = false) => {
    if (!confirmed && hasContent && current && current.id !== a.id) {
      setPendingAgent(a);
      setModal("change-agent");
      return;
    }
    if (agentNeedsInitialPreparation(a) || hasPendingOnboarding(a)) {
      setModal(null);
      onExplore(a.id, { intent: "use" });
      return;
    }
    onChoiceChange?.();
    setChoice({
      agent: a.name,
      agentId: a.id,
      model: a.model ?? a.models?.[0] ?? "",
      source: a.source || "沿用已有设置",
      serviceId: a.sourceId,
      serviceSnapshot:
        a.accessMode === "api"
          ? structuredClone(
              a.serviceSnapshot ||
                services.find((s) => s.id === a.sourceId) ||
                null,
            )
          : null,
      accessMode: a.accessMode || "existing",
      effort: a.effort || a.efforts?.[0] || "",
    });
    setModal(null);
  };
  const modelDialog = () => {
    setModelDraft({ ...choice });
    setModal("model");
  };
  const commitModel = (model, service) =>
    setModelDraft((c) => ({
      ...c,
      model,
      source: service ? service.name : "沿用已有设置",
      serviceId: service?.id,
      serviceSnapshot: service ? structuredClone(service) : null,
      accessMode: service ? "api" : "existing",
    }));
  const addFile = (f) => {
    setFiles((fs) => [...new Set([...fs, f])]);
    setModal(null);
  };
  const requestSend = () => {
    if (!ready) return onExplore(current?.id || null);
    if (!folder) return setModal("send-folder");
    onSend();
  };
  return (
    <section className={"v2-start new" + (draftWeb ? " with-draft-web" : "")}>
      <div className="v2-start-intro">
        <span className="redesign-kicker">从一个想法开始</span>
        <h1>今天，想完成什么？</h1>
        <p>先写下目标，再和合适的 Agent 一起推进。</p>
      </div>
      {recoveryNotice}
      <div className="v2-compose-card">
        {files.length > 0 && (
          <div className="v2-attached">
            {files.map((f) => (
              <span key={f}>
                <FileText size={14} />
                {f}
                <button
                  aria-label={"移除 " + f}
                  onClick={() => setFiles((fs) => fs.filter((x) => x !== f))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          aria-label="新对话内容"
          placeholder="描述想完成的事，或添加一份资料…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!hasContent || pending || !workEnabled) return;
              requestSend();
            }
          }}
        />
        <div className="v2-compose-bottom">
          <div className="v2-compose-controls">
            <button
              className="v2-plus"
              aria-label="添加内容"
              onClick={() => setModal("add")}
            >
              <Plus size={20} />
            </button>
            <button
              className="v2-agent-choice"
              aria-label="选择 Agent"
              disabled={pending}
              onClick={() => {
                setSearch("");
                setModal("agent");
              }}
            >
              {choice.agent && <AgentIcon name={choice.agent} size={19} />}
              {choice.agent || "选择 Agent"}
              <CaretDown size={11} />
            </button>
            <span className="v2-control-divider" />
            <button
              className="v2-model-choice"
              aria-label="选择模型与来源"
              disabled={!ready || pending}
              title={!ready ? "先完成 Agent 接入，再选择模型" : undefined}
              onClick={modelDialog}
            >
              {ready
                ? choice.model || "沿用现有模型"
                : current
                  ? "准备好后选择"
                  : "先选择 Agent"}
              <CaretDown size={11} />
            </button>
            {current?.efforts?.length > 0 && (
              <label className="composer-effort" title="思考深度">
                <span>思考</span>
                <select
                  aria-label="思考深度"
                  value={choice.effort}
                  disabled={!ready || pending}
                  onChange={(e) =>
                    setChoice((c) => ({ ...c, effort: e.target.value }))
                  }
                >
                  {current.efforts.map((effort) => (
                    <option key={effort}>{effort}</option>
                  ))}
                </select>
                <CaretDown size={11} aria-hidden="true" />
              </label>
            )}
            <PermissionControl
              key={current?.id}
              capability={permission?.permissionCapability}
              value={permission?.permissionValue}
              disabled={!ready || pending}
              disabledReason={
                pending ? "消息发送中，暂不能更改权限。" : "先完成 Agent 接入。"
              }
              onChange={(permissionValue) =>
                setChoice((c) => ({ ...c, permissionValue }))
              }
            />
            <button
              className="v2-tune"
              aria-label="对话选项"
              disabled={!ready || pending}
              onClick={() => setModal("options")}
            >
              <SlidersHorizontal size={17} />
            </button>
          </div>
          <button
            className="v2-send"
            aria-label={
              ready ? "发送新对话" : current ? "继续设置 Agent" : "挑选 Agent"
            }
            disabled={pending || (ready && (!hasContent || !workEnabled))}
            onClick={requestSend}
          >
            {pending ? (
              <span>发送中</span>
            ) : ready ? (
              <ArrowUp size={20} />
            ) : (
              <span>{current ? "继续设置" : "挑选 Agent"}</span>
            )}
          </button>
        </div>
      </div>
      {(sendError || !workEnabled) && (
        <div className="workbench-send-message" role="status">
          <span>
            {!workEnabled
              ? `${folder ? "此文件夹" : "普通对话"}已暂停发送，草稿保留。`
              : sendError}
          </span>
          {!workEnabled && <Button onClick={onResumeSending}>恢复发送</Button>}
          {(apiAuthBlocked || selectedServiceIssue) && (
            <Button onClick={onManageServices}>更新 API 配置</Button>
          )}
          {current &&
            accountRequiredForSelection(current, { ...choice, folder }) && (
              <Button
                onClick={() =>
                  onExplore(current.id, {
                    repair: "account",
                    panel: "account",
                    reason:
                      "刚才的消息需要登录。完成后返回草稿，由你确认后重新发送。",
                  })
                }
              >
                完成登录
              </Button>
            )}
        </div>
      )}
      <div className="v2-compose-caption">
        <span>
          {!ready
            ? current
              ? "完成接入后就能开始，输入会留在这里。"
              : "先找一个合适的 Agent，想法也可以先写下来。"
            : choice.source === "沿用已有设置"
              ? "使用 " + choice.agent + " 已有账号与模型设置"
              : (services.find((s) => s.id === choice.serviceId)?.name ||
                  choice.source) + " · 仅本次选择的来源"}
        </span>
        <small>
          {!workEnabled
            ? "发送已暂停 · 草稿保留"
            : "Enter 发送 · Shift Enter 换行"}
        </small>
      </div>
      <div className="draft-context-row">
        <button onClick={() => setModal("folder")}>
          <FolderSimple size={16} />
          <span>{folder || "选择工作文件夹"}</span>
        </button>
        {folder && (
          <button
            aria-label="移除工作文件夹"
            onClick={() => {
              setFolder("");
              setDraftWeb(false);
            }}
          >
            <X size={14} />
          </button>
        )}
        <span>
          {folder
            ? "仅作为工作位置，权限另行确认"
            : "可以先写，首次发送前再选择"}
        </span>
        <button
          className="draft-web-open"
          disabled={!ready || !folder}
          title={
            !ready || !folder
              ? "选择可用 Agent 和工作文件夹后打开"
              : "查看网页不会发送消息"
          }
          onClick={() => setDraftWeb(true)}
        >
          <Globe size={16} />
          打开网页
        </button>
      </div>
      {draftWeb && (
        <DraftWebPreview
          scope={JSON.stringify([
            choice.agentId || choice.agent,
            choice.accessMode,
            choice.serviceId,
            choice.serviceSnapshot?.endpoint,
            choice.serviceSnapshot?.format,
            folder,
          ])}
          onClose={() => setDraftWeb(false)}
        />
      )}
      <div className="v2-suggestions">
        {!draft.trim() &&
          [
            [
              AirplaneTilt,
              "计划一次旅行",
              "想安排一段轻松的旅行，帮我一起想想。",
            ],
            [
              PencilLine,
              "把想法写清楚",
              "我有一些零散的想法，帮我整理成一段自然的表达。",
            ],
            [
              BookOpen,
              "一起读点东西",
              "帮我梳理这份读书笔记，保留值得继续想的问题。",
            ],
          ].map(([Icon, label, text]) => (
            <button key={label} onClick={() => setDraft(text)}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        <button onClick={() => onExplore()}>
          <Compass size={16} />
          发现更多 Agent
        </button>
      </div>
      {modal === "agent" && (
        <Modal title="选择 Agent" onClose={() => setModal(null)}>
          <input
            className="v2-picker-search"
            aria-label="搜索已添加的 Agent"
            placeholder="搜索你的 Agent"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="v2-picker-list">
            {!selectable.some((a) =>
              a.name.toLowerCase().includes(search.toLowerCase()),
            ) && (
              <p className="picker-empty">
                {search
                  ? "没有匹配的 Agent。换个名称，或前往探索添加。"
                  : "还没有添加 Agent。先去探索，草稿会保留。"}
              </p>
            )}
            {selectable
              .filter((a) =>
                a.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((a) => (
                <button key={a.id} onClick={() => chooseAgent(a)}>
                  <AgentIcon name={a.name} size={25} />
                  <span>
                    <strong>{a.name}</strong>
                    <small>
                      {hasPendingOnboarding(a) ||
                      agentNeedsInitialPreparation(a)
                        ? "继续准备"
                        : agentCanStartConversation(a)
                          ? "可以开始"
                          : "还差一步 · 保留选择并继续设置"}
                    </small>
                  </span>
                  {selectionMatchesAgent(a, choice) && <Check size={16} />}
                </button>
              ))}
          </div>
          <button
            className="v2-picker-discover"
            onClick={() => {
              setModal(null);
              onExplore();
            }}
          >
            <Plus size={16} />
            添加其他 Agent
          </button>
        </Modal>
      )}
      {modal === "model" && modelDraft && (
        <Modal
          title="选择模型"
          onClose={() => setModal(null)}
          footer={
            <>
              <Button
                kind="ghost"
                onClick={() => {
                  setModal(null);
                  onExplore(current?.id || null);
                }}
              >
                Agent 设置
              </Button>
              <Button
                kind="ghost"
                onClick={() => {
                  setModal(null);
                  onManageServices?.();
                }}
              >
                管理 API 服务
              </Button>
              <Button
                primary
                disabled={Boolean(modelIssue)}
                onClick={() => {
                  if (modelIssue) return;
                  onChoiceChange?.();
                  setChoice(modelDraft);
                  setModal(null);
                }}
              >
                使用这个模型
              </Button>
            </>
          }
        >
          <div className="v2-model-groups">
            <div className="selection-source-summary">
              <small>本次草稿的服务来源</small>
              <strong>{modelDraft.source || "沿用已有设置"}</strong>
              <span>
                {modelDraft.serviceSnapshot?.endpoint ||
                  "具体账号与服务信息未提供，不推测身份"}
              </span>
            </div>
            <h3>{choice.agent} 的已有设置</h3>
            <p>使用 Agent 已有的账号或服务设置。</p>
            {!existingModels.length && (
              <button
                onClick={() => commitModel("")}
                className={
                  modelDraft.accessMode === "existing" ? "selected" : ""
                }
              >
                沿用 Agent 当前模型
              </button>
            )}
            {existingModels.map((m) => (
              <button
                key={m}
                className={
                  modelDraft.model === m && modelDraft.source === "沿用已有设置"
                    ? "selected"
                    : ""
                }
                onClick={() => commitModel(m)}
              >
                <span>{m}</span>
                {modelDraft.model === m &&
                  modelDraft.source === "沿用已有设置" && <Check size={16} />}
              </button>
            ))}
            {compatible.length > 0 && (
              <>
                <h3>
                  你保存的 API 服务
                  {serviceAccess(current) === "proposal" ? " · 接入提案" : ""}
                </h3>
                {compatible.map((s) => (
                  <div key={s.id}>
                    <small>{s.name}</small>
                    {s.models.map((m) => (
                      <button
                        key={m}
                        className={
                          modelDraft.model === m &&
                          modelDraft.serviceId === s.id
                            ? "selected"
                            : ""
                        }
                        onClick={() => commitModel(m, s)}
                      >
                        <span>{m}</span>
                        {modelDraft.model === m &&
                          modelDraft.serviceId === s.id && <Check size={16} />}
                      </button>
                    ))}
                  </div>
                ))}
              </>
            )}
            {serviceAccess(current) === "unavailable" && (
              <p>
                {choice.agent}{" "}
                暂不支持使用这里保存的服务。可继续使用它已有的设置。
              </p>
            )}
            {serviceAccess(current) !== "unavailable" &&
              compatible.length === 0 && (
                <p>还没有兼容的服务，可前往 API 管理添加。</p>
              )}
            {modelIssue && <p role="alert">{modelIssue}</p>}
          </div>
          <p className="v2-help">
            首次发送后，Agent 和服务来源固定。工作完成后，若 Agent
            支持，可以更改后续请求的模型与思考深度。
          </p>
        </Modal>
      )}
      {modal === "options" && (
        <Modal title="对话选项" onClose={() => setModal(null)}>
          <Button onClick={() => setModal("folder")}>
            <FolderSimple size={16} />
            {folder || "添加文件夹"}
          </Button>
          <p className="v2-help">
            草稿可以先写。首次发送前需要选择工作文件夹；分组只负责整理对话。
          </p>
        </Modal>
      )}
      {modal === "add" && (
        <Modal title="添加到这段对话" onClose={() => setModal(null)}>
          <div className="v2-action-list">
            <button onClick={() => setModal("files")}>
              <Paperclip size={19} />
              <span>
                <strong>添加文件</strong>
                <small>带上一份资料，让对话更具体</small>
              </span>
            </button>
            <button onClick={() => setModal("folder")}>
              <FolderSimple size={19} />
              <span>
                <strong>选择文件夹</strong>
                <small>首次发送前需要选择，取消后草稿保留</small>
              </span>
            </button>
            <button onClick={() => setModal("commands")}>
              <SlidersHorizontal size={19} />
              <span>
                <strong>Agent 命令</strong>
                <small>查看这个 Agent 提供的快捷操作</small>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {modal === "files" && (
        <Modal title="选择演示文件" onClose={() => setModal(null)}>
          <p className="v2-help">这里只添加示例文件名，不读取你的电脑。</p>
          <div className="v2-action-list">
            {["旅行偏好.md", "读书笔记.md", "项目说明.md"].map((f) => (
              <button key={f} onClick={() => addFile(f)}>
                <FileText size={19} />
                {f}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {["folder", "send-folder"].includes(modal) && (
        <Modal
          title={
            modal === "send-folder"
              ? "发送前，选择工作文件夹"
              : "选择演示文件夹"
          }
          onClose={() => setModal(null)}
          footer={<Button onClick={() => setModal(null)}>返回草稿</Button>}
        >
          <p className="v2-help">
            文件夹是这段对话的工作位置。选择后回到草稿，由你确认发送；取消不会丢失内容。本原型只选择示例名称，不读取你的文件。
          </p>
          <div className="v2-action-list">
            {["旅行资料", "阅读笔记", "个人网站"].map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFolder(f);
                  setModal(null);
                }}
              >
                <FolderSimple size={19} />
                {f}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {modal === "commands" && (
        <Modal title="Agent 命令示例" onClose={() => setModal(null)}>
          <p className="v2-help">
            正式使用时，只显示这个 Agent 实际提供的命令。
          </p>
          <div className="v2-action-list">
            {[
              ["/help", "查看可用帮助"],
              ["/compact", "整理当前对话上下文"],
            ].map(([c, d]) => (
              <button
                key={c}
                onClick={() => {
                  setDraft((text) => `${c} ${text}`);
                  setModal(null);
                }}
              >
                <span>
                  <strong>{c}</strong>
                  <small>{d}</small>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {modal === "change-agent" && pendingAgent && (
        <Modal
          title="把这份草稿交给另一个 Agent？"
          onClose={() => setModal(null)}
          footer={
            <>
              <Button onClick={() => setModal(null)}>保留当前选择</Button>
              <Button primary onClick={() => chooseAgent(pendingAgent, true)}>
                保留草稿并切换
              </Button>
            </>
          }
        >
          <p>
            文字、附件和工作文件夹会保留。模型与服务设置会使用新 Agent
            的选择，内容不会自动发送。
          </p>
          <div className="draft-agent-comparison">
            <div>
              <small>当前</small>
              <strong>{current?.name}</strong>
              <span>
                {choice.model || "当前模型未提供"} ·{" "}
                {choice.source || "沿用已有设置"}
              </span>
            </div>
            <div>
              <small>切换后</small>
              <strong>{pendingAgent.name}</strong>
              <span>
                {pendingAgent.model || "完成设置后选择模型"} ·{" "}
                {pendingAgent.source || "沿用已有设置"}
              </span>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
