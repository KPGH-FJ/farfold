import React, { useState } from "react";
import {
  CheckCircle,
  ShieldCheck,
  Folder,
  Key,
  BookOpen,
  DownloadSimple,
} from "@phosphor-icons/react";
import { Button, Modal, Field, Notice, Badge } from "./ui.jsx";
import {
  CLEAR_DATA_REMOVES,
  CLEAR_DATA_KEEPS,
} from "./settings-library-state.js";

export function DiagnosticExport({ onClose }) {
  const [step, setStep] = useState("scope");
  const [note, setNote] = useState("");
  const sections = [
    ["应用与系统", "Farfold 0.1.7 · macOS · 仅示例版本信息"],
    ["运行概况", "1 次请求完成 · 0 次未知结果 · 示例耗时 1.2 秒"],
    ["事件摘要", "程序就绪 → 发送请求 → 收到完成结果。仅保留事件类型和耗时。"],
    ["问题说明", note.trim() || "未填写"],
  ];
  return (
    <Modal
      title={
        step === "preview"
          ? "预览诊断内容"
          : step === "done"
            ? "导出结果示例"
            : "准备诊断记录"
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          {step === "scope" && (
            <Button primary onClick={() => setStep("preview")}>
              先预览内容
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button onClick={() => setStep("scope")}>返回修改</Button>
              <Button primary onClick={() => setStep("done")}>
                <DownloadSimple size={15} />
                确认导出示例
              </Button>
            </>
          )}
        </>
      }
    >
      {step === "scope" && (
        <>
          <p className="sl-dialog-lead">
            先检查内容，再决定是否保存。不会自动发送给任何人。
          </p>
          <div className="sl-scope-grid">
            <section>
              <h3>包含</h3>
              <p>应用版本、事件类型、耗时与受限设置。</p>
            </section>
            <section>
              <h3>不包含</h3>
              <p>对话正文、文件内容、密钥、命令内容与项目路径。</p>
            </section>
          </div>
          <Field
            label="你遇到的问题（可选）"
            hint="这段文字会原样加入，请勿填写密钥或私人内容。"
          >
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：打开一个文件后没有显示正文。"
            />
          </Field>
        </>
      )}
      {step === "preview" && (
        <>
          <div className="sl-preview-summary">
            <strong>4 类内容，可逐项展开核对</strong>
            <Badge>示例内容</Badge>
          </div>
          {sections.map(([title, text]) => (
            <details
              className="sl-preview-group"
              key={title}
              open={title === "问题说明" && !!note.trim()}
            >
              <summary>
                {title}
                <span>
                  {title === "问题说明"
                    ? note.trim()
                      ? "包含你填写的文字"
                      : "未填写"
                    : "1 项示例"}
                </span>
              </summary>
              <p>{text}</p>
            </details>
          ))}
          <p className="sl-search-scope">
            此处展示完整的演示包内容，没有读取真实日志或项目文件。
          </p>
        </>
      )}
      {step === "done" && (
        <>
          <Notice tone="success" title="已完成导出结果演示">
            示例文件名：farfold-diagnostics-demo.zip。原型未创建、保存或上传文件。
          </Notice>
          <Button onClick={() => setStep("preview")}>返回检查内容</Button>
        </>
      )}
    </Modal>
  );
}

export function DataPrivacy({
  onClose,
  blockedTasks = [],
  storageIssue = false,
}) {
  const [view, setView] = useState("overview");
  const [ack, setAck] = useState(false);
  const blocked = storageIssue || blockedTasks.length > 0;
  return (
    <Modal
      title={
        view === "clear"
          ? "清除 Farfold 数据"
          : view === "done"
            ? "清除结果示例"
            : view === "uninstall"
              ? "完整卸载 Farfold"
              : "数据与隐私"
      }
      onClose={onClose}
      footer={
        <>
          <Button
            onClick={
              view === "overview" || view === "done"
                ? onClose
                : () => {
                    setView("overview");
                    setAck(false);
                  }
            }
          >
            {view === "overview" || view === "done" ? "关闭" : "返回数据说明"}
          </Button>
          {view === "clear" && (
            <Button
              className="set-danger"
              disabled={blocked || !ack}
              onClick={() => setView("done")}
            >
              查看清除完成示例
            </Button>
          )}
        </>
      }
    >
      {view === "overview" && (
        <>
          <div className="sl-data-ownership">
            {[
              [
                Folder,
                "对话目录与应用设置",
                "Farfold 保存在本机，包含标题、分组、收藏和偏好。",
              ],
              [
                BookOpen,
                "完整对话与工作历史",
                "由各 Agent 自己管理，Farfold 通过其提供的能力读取和继续。",
              ],
              [
                Key,
                "API 密钥",
                "正式产品保存在系统安全存储；仅在你选择服务后交付使用。",
              ],
              [ShieldCheck, "LifeModel", "当前未启用，不采集也不用于对话。"],
            ].map(([Icon, title, text]) => (
              <section key={title}>
                <Icon size={19} />
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </section>
            ))}
          </div>
          <div className="sl-danger-row">
            <div>
              <h3>清除 Farfold 数据</h3>
              <p>先核对删除与保留范围，再确认。不会删除用户项目。</p>
            </div>
            <Button
              className="set-danger-text"
              onClick={() => setView("clear")}
            >
              查看清除范围
            </Button>
          </div>
          <div className="sl-danger-row">
            <div>
              <h3>完整卸载</h3>
              <p>清理应用拥有的数据后，再移除应用。</p>
            </div>
            <Button onClick={() => setView("uninstall")}>查看卸载步骤</Button>
          </div>
        </>
      )}
      {view === "clear" && (
        <>
          <p className="sl-dialog-lead">
            这项操作会移除 Farfold
            拥有的数据，无法撤销。请先保留需要的草稿和资料。
          </p>
          <div className="sl-scope-grid">
            <section>
              <h3>将删除</h3>
              <ul>
                {CLEAR_DATA_REMOVES.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
            <section>
              <h3>仍保留</h3>
              <ul>
                {CLEAR_DATA_KEEPS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </section>
          </div>
          {blocked && (
            <Notice
              tone="warning"
              title={storageIssue ? "本地保存尚未恢复" : "还有工作需要先处理"}
            >
              {storageIssue
                ? "请先复制保留未发送内容，恢复保存后再回来。"
                : "进行中、待回应或结果未知的工作未结束，现在不能清除。"}
              {blockedTasks.map((t) => (
                <p key={t.id}>{t.title}</p>
              ))}
            </Notice>
          )}
          <label className="sl-confirm-check">
            <input
              type="checkbox"
              disabled={blocked}
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            我已核对范围，并保留需要的内容
          </label>
          <p className="sl-search-scope">
            演示不会执行磁盘清理、清除密钥或卸载程序。
          </p>
        </>
      )}
      {view === "done" && (
        <Notice tone="success" title="清除完成后的结果示例">
          正式流程完成后将回到首次使用。这个原型仅演示确认与结果，当前示例数据也未被删除。
        </Notice>
      )}
      {view === "uninstall" && (
        <>
          <ol className="sl-step-list">
            <li>
              <strong>先保留正在处理的内容</strong>
              <p>
                结束进行中的工作，处理未知结果，备份需要的草稿和应用对话文件夹中的文件。
              </p>
            </li>
            <li>
              <strong>在应用内清除 Farfold 数据</strong>
              <p>
                核对上方范围，等待清理完成。清理失败时保留提示并重试，不能当作已清除。
              </p>
              <Button onClick={() => setView("clear")}>查看清除范围</Button>
            </li>
            <li>
              <strong>退出并移除 Farfold 应用</strong>
              <p>
                将“应用程序”中的 Farfold
                移到废纸篓。只移除应用不会自动清理其他数据。
              </p>
            </li>
            <li>
              <strong>按需单独管理 Agent</strong>
              <p>
                各 Agent
                的账号、外部安装、配置与历史仍保留；如需移除，请使用对应官方方式。
              </p>
            </li>
          </ol>
          <p className="sl-search-scope">
            本页只提供步骤，不执行退出、清理或卸载。
          </p>
        </>
      )}
    </Modal>
  );
}

export function ApiServiceGuide({ onClose, onUseSample }) {
  const [page, setPage] = useState("steps");
  return (
    <div className="settings-redesign">
      <Modal
        title="准备 API 服务信息"
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>返回配置</Button>
            {page === "console" && (
              <Button primary onClick={onUseSample}>
                用演示信息补齐空字段
              </Button>
            )}
          </>
        }
      >
        <p className="sl-dialog-lead">
          已有服务无需重复注册。需要准备基础地址、接口格式、密钥和模型名称。
        </p>
        {page === "steps" ? (
          <ol className="sl-step-list">
            <li>
              <strong>找到服务方提供的 API 文档</strong>
              <p>核对基础地址与接口格式。Agent 订阅不等于已开通 API 服务。</p>
            </li>
            <li>
              <strong>在服务方控制台管理密钥</strong>
              <p>
                使用自己的账号创建专用密钥，并核对其额度和权限。不要把密钥填进此原型。
              </p>
            </li>
            <li>
              <strong>回到此处填写并保存</strong>
              <p>模型可读取或手动添加；保存后还需到 Agent 中选择这项服务。</p>
              <Button onClick={() => setPage("console")}>
                查看服务文档与密钥页示例
              </Button>
            </li>
          </ol>
        ) : (
          <>
            <div className="sl-preview-summary">
              <strong>服务方控制台 · 内容示例</strong>
              <Badge>未打开真实网站</Badge>
            </div>
            <dl className="sl-source-diff">
              <div>
                <dt>基础地址</dt>
                <dd>https://models.example.com/v1</dd>
              </div>
              <div>
                <dt>接口格式</dt>
                <dd>Responses</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>Atria Fast</dd>
              </div>
              <div>
                <dt>密钥管理</dt>
                <dd>新建专用密钥 → 核对权限与额度 → 保存一次性值</dd>
              </div>
            </dl>
            <p>
              真实入口必须来自你所选服务的官方文档；当前没有可核实的官网地址，因此不制造外链。
            </p>
            <Button onClick={() => setPage("steps")}>返回准备步骤</Button>
          </>
        )}
      </Modal>
    </div>
  );
}
