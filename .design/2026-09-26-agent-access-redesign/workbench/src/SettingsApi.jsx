import React, { useEffect, useId, useRef, useState } from "react";
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
  changeApiDraft,
  confirmDemoKey,
  draftKeyReady,
  initialApiDraft,
  savedApiRecord,
  API_FORMATS,
  apiEndpointIssue,
  apiDraftIssue,
  apiRecordVersion,
  validModel,
  createDiagnosticScope,
  filterApiServices,
} from "./api-editor-state.js";
import { serviceConversations } from "./agent-setup-state.js";
import { AGENT_CATALOG } from "./agent-catalog.js";
import { compatibleServices } from "./service-access.js";
import ApiTest from "./settings-api-diagnostic.jsx";
import "./settings-api-lifecycle.css";
import RegistrationJourney from "./RegistrationJourney.jsx";
import { registrationMatchesService } from "./account-handoff.js";
import {
  beginRegistration,
  registrationTransition,
} from "./registration-state.js";
const START_SERVICES = [
  {
    id: "workspace",
    name: "Workspace API",
    provider: "团队模型服务",
    endpoint: "https://models.example.com/v1",
    format: "responses",
    models: ["Atria Dawn", "Atria Fast"],
    demoKey: true,
    uses: 2,
    revision: 0,
  },
  {
    id: "personal",
    name: "个人模型服务",
    provider: "自定义来源",
    endpoint: "https://personal.example.com/v1",
    format: "chat-completions",
    models: ["GLM-4.5-Air"],
    demoKey: true,
    uses: 0,
    revision: 0,
  },
];
const FORMAT_NAMES = API_FORMATS;
const compatibleAgents = (service, agents) =>
  agents.filter((agent) => compatibleServices(agent, [service]).length);
const serviceBlank = () => ({
  id: null,
  name: "",
  provider: "",
  endpoint: "",
  format: "responses",
  models: [],
  demoKey: false,
  uses: 0,
  revision: 0,
});
export function ServiceEditor({
  service = null,
  services,
  agents = AGENT_CATALOG,
  onSave,
  onCancel,
}) {
  const item = service;
  const onClose = onCancel;
  const [saving, setSaving] = useState(false);
  const [registration, setRegistration] = useState(null);
  const [chooseProvider, setChooseProvider] = useState(false);
  const [saveFail, setSaveFail] = useState(false);
  const originalVersion = useRef(apiRecordVersion(service));
  const [draft, setDraft] = useState(() =>
    initialApiDraft(item || serviceBlank()),
  );
  const original = useRef(JSON.stringify(draft));
  const pendingModel = useRef("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [discard, setDiscard] = useState(false);
  const [modelInput, setModelInput] = useState("");
  const [catalog, setCatalog] = useState(null);
  const [selected, setSelected] = useState([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchFail, setFetchFail] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [error, setError] = useState("");
  const [errorTarget, setErrorTarget] = useState("general");
  const [errorAttempt, setErrorAttempt] = useState(0);
  const [endpointTouched, setEndpointTouched] = useState(false);
  const modelInputRef = useRef(null);
  const generalErrorRef = useRef(null);
  const modelErrorId = useId();
  const endpointHintId = useId();
  const endpointErrorId = useId();
  const saveHintId = useId();
  const request = useRef(createDiagnosticScope());
  const fetchTimer = useRef(null);
  const showError = (message, target = "general") => {
    setError(message);
    setErrorTarget(target);
    setErrorAttempt((value) => value + 1);
  };
  useEffect(() => {
    if (!error || saving) return;
    const target =
      errorTarget === "model" ? modelInputRef.current : generalErrorRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [error, errorTarget, errorAttempt, saving]);
  useEffect(
    () => () => {
      request.current.invalidate();
      clearTimeout(fetchTimer.current);
    },
    [],
  );
  const close = () => {
    if (saving) return;
    request.current.invalidate();
    clearTimeout(fetchTimer.current);
    setFetching(false);
    if (
      JSON.stringify(draftRef.current) !== original.current ||
      pendingModel.current.trim()
    )
      setDiscard(true);
    else onClose();
  };
  const change = (key, value) => {
    request.current.invalidate();
    setFetching(false);
    setFetchError(false);
    setDraft((d) => changeApiDraft(d, key, value));
    if (["endpoint", "format", "demoKey"].includes(key)) {
      setCatalog(null);
      setSelected([]);
    }
    setError("");
  };
  const startRegistration = () => {
    if (!draft.provider.trim()) {
      setChooseProvider(true);
      return;
    }
    setChooseProvider(false);
    setRegistration(
      registrationMatchesService(registration, draft)
        ? registrationTransition(registration, "resume")
        : beginRegistration({
            kind: "api",
            accountLabel: draft.provider.trim(),
            selection: {
              name: draft.name,
              endpoint: draft.endpoint,
              format: draft.format,
            },
          }),
    );
  };
  const changedSource =
    !!item &&
    (draft.endpoint !== item.endpoint || draft.format !== item.format);
  const keyReady = draftKeyReady(draft);
  const endpointIssue = apiEndpointIssue(draft.endpoint);
  const showEndpointIssue =
    !!endpointIssue && (endpointTouched || !!draft.endpoint.length);
  const ready = !endpointIssue && keyReady;
  const saveIssue = apiDraftIssue(draft, modelInput);
  const addModel = () => {
    const m = modelInput.trim();
    if (!validModel(m)) {
      showError("请填写不超过 256 字、没有控制字符的模型 ID。", "model");
      return;
    }
    change("models", [...new Set([...draft.models, m])]);
    setModelInput("");
    pendingModel.current = "";
  };
  const fetch = () => {
    if (!ready || fetching) return;
    const id = request.current.begin();
    setFetching(true);
    setFetchError(false);
    fetchTimer.current = setTimeout(() => {
      if (!request.current.finish(id)) return;
      setFetching(false);
      if (fetchFail) {
        setFetchError(true);
        return;
      }
      setCatalog([
        "Atria-Dawn-Preview",
        "gpt-6-astra",
        "GLM-4.5-Air",
        "research-small",
        "code-fast",
        "general-large",
      ]);
      setSelected([]);
    }, 800);
  };
  const save = async () => {
    if (saving) return;
    const issue = apiDraftIssue(draft, pendingModel.current);
    if (issue) {
      showError(
        issue,
        !apiDraftIssue(draft) && pendingModel.current.trim()
          ? "model"
          : "general",
      );
      return;
    }
    if (
      item &&
      services &&
      apiRecordVersion(services.find((value) => value.id === item.id)) !==
        originalVersion.current
    ) {
      showError(
        "此配置已在其他位置改变或删除。请保留当前输入，关闭后重新打开。",
      );
      return;
    }
    request.current.invalidate();
    clearTimeout(fetchTimer.current);
    setFetching(false);
    setSaving(true);
    setError("");
    try {
      if (saveFail)
        throw new Error("模拟保存失败；原配置和密钥未被替换，当前输入仍保留。");
      await onSave(savedApiRecord(draft));
    } catch (reason) {
      showError(reason.message || "未能保存配置，当前输入仍保留。");
    } finally {
      setSaving(false);
    }
  };
  const affected =
    !!item &&
    (changedSource || item.models.some((m) => !draft.models.includes(m)));
  if (chooseProvider)
    return (
      <Modal
        title="选择 API 服务"
        onClose={() => setChooseProvider(false)}
        footer={
          <>
            <Button onClick={() => setChooseProvider(false)}>返回配置</Button>
            <Button
              primary
              disabled={!draft.provider.trim()}
              onClick={startRegistration}
            >
              继续
            </Button>
          </>
        }
      >
        <div className="set-form">
          <Field
            label="服务方"
            hint="填写准备使用的服务，再继续注册或获取密钥。"
          >
            <input
              autoFocus
              value={draft.provider}
              onChange={(e) => change("provider", e.target.value)}
              placeholder="公司、平台或自己的服务"
            />
          </Field>
          <p className="set-caption">此处演示获取流程，原配置内容保留。</p>
        </div>
      </Modal>
    );
  if (registration?.open)
    return (
      <Modal
        title="API 账号与密钥"
        onClose={() =>
          setRegistration(registrationTransition(registration, "return"))
        }
        footer={<span>API 配置输入保留；没有保存或发送密钥</span>}
      >
        <RegistrationJourney state={registration} onChange={setRegistration} />
      </Modal>
    );
  return (
    <>
      <Modal
        wide
        title={item ? "编辑 API 配置" : "添加 API 配置"}
        onClose={close}
        footer={
          <>
            <span
              className="set-save-hint set-save-feedback"
              id={saveHintId}
              aria-live="polite"
            >
              {saveIssue && <span>{saveIssue}</span>}
              <small>保存无需先测试</small>
            </span>
            <Button onClick={close}>取消</Button>
            <Button
              primary
              onClick={save}
              disabled={saving || !!saveIssue}
              aria-describedby={saveHintId}
            >
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </>
        }
      >
        <fieldset
          className="settings-api-editor"
          disabled={saving}
          aria-busy={saving}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <div className="set-editor-intro">
            <p>保存完整的模型服务，在新对话中选择来源和模型。</p>
            <Badge>演示数据</Badge>
          </div>
          <div className="registration-shortcuts">
            <Button onClick={startRegistration}>
              {registrationMatchesService(registration, draft)
                ? "查看账号与密钥获取进度"
                : "没有账号或密钥，查看获取流程"}
            </Button>
            <p>
              {registrationMatchesService(registration, draft) &&
              registration?.status === "key-issued"
                ? "已模拟取得密钥；请继续填写配置。没有保存，也没有向 Agent 分发。"
                : "已有密钥直接填写下方配置。API 服务账号与 Agent 订阅分别管理。"}
            </p>
          </div>
          <div className="set-form set-form-grid">
            <Field label="配置名称">
              <input
                autoFocus
                value={draft.name}
                onChange={(e) => change("name", e.target.value)}
                placeholder="例如：我的模型服务"
              />
            </Field>
            <Field label="提供方（可选）">
              <input
                value={draft.provider}
                onChange={(e) => change("provider", e.target.value)}
                placeholder="公司、平台或自己的服务"
              />
            </Field>
            <div className="set-span-two">
              <Field label="基础地址">
                <input
                  type="url"
                  value={draft.endpoint}
                  aria-invalid={showEndpointIssue || undefined}
                  aria-describedby={
                    showEndpointIssue
                      ? `${endpointHintId} ${endpointErrorId}`
                      : endpointHintId
                  }
                  onBlur={() => setEndpointTouched(true)}
                  onChange={(e) => change("endpoint", e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
                <small id={endpointHintId}>
                  填写完整的 HTTPS 基础地址，不包含 /chat/completions、/responses
                  或 /messages。
                </small>
                {showEndpointIssue && (
                  <span
                    id={endpointErrorId}
                    className="set-field-error"
                    aria-live="polite"
                  >
                    {endpointIssue}
                  </span>
                )}
              </Field>
            </div>
            <Field
              label="接口格式"
              hint="按服务文档选择，不通过提供方名称猜测。"
            >
              <select
                value={draft.format}
                onChange={(e) => change("format", e.target.value)}
              >
                {Object.entries(FORMAT_NAMES).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="API Key"
              hint="原型不接受真实密钥，仅使用固定演示值。"
            >
              <div className="set-demo-key">
                <input
                  readOnly
                  value={keyReady ? "•••••••• 演示密钥" : "尚未使用演示密钥"}
                  aria-label="只读演示密钥"
                  tabIndex={-1}
                />
                <Button
                  onClick={() => {
                    request.current.invalidate();
                    setFetching(false);
                    setFetchError(false);
                    setCatalog(null);
                    setSelected([]);
                    setDraft(confirmDemoKey);
                    setError("");
                  }}
                >
                  {keyReady ? "替换演示值" : "使用演示密钥"}
                </Button>
              </div>
            </Field>
          </div>
          {changedSource && (
            <Notice tone="warning" title="服务地址或接口已改变">
              已有密钥不会自动发送到新地址。请重新选择演示密钥；正式产品要求为新来源重新填写密钥。
            </Notice>
          )}
          <section className="set-model-editor">
            <div className="set-section-title">
              <div>
                <h3>
                  可选模型{" "}
                  <span className="set-count">{draft.models.length}</span>
                </h3>
                <p>读取列表后选择需要的模型，也可以手动添加。</p>
              </div>
              {fetching ? (
                <Button
                  onClick={() => {
                    request.current.invalidate();
                    clearTimeout(fetchTimer.current);
                    setFetching(false);
                  }}
                >
                  取消读取
                </Button>
              ) : (
                <Button disabled={!ready} onClick={fetch}>
                  <ArrowClockwise
                    size={16}
                    className={fetching ? "spin" : ""}
                  />
                  读取模型列表
                </Button>
              )}
            </div>
            <div className="set-model-add">
              <input
                ref={modelInputRef}
                value={modelInput}
                aria-label="手动添加模型 ID"
                aria-invalid={
                  error && errorTarget === "model" ? true : undefined
                }
                aria-describedby={
                  error && errorTarget === "model" ? modelErrorId : undefined
                }
                placeholder="输入模型 ID"
                onChange={(e) => {
                  setModelInput(e.target.value);
                  pendingModel.current = e.target.value;
                  if (errorTarget === "model") setError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addModel();
                  }
                }}
              />
              <Button onClick={addModel} disabled={!modelInput.trim()}>
                <Plus size={15} />
                添加
              </Button>
            </div>
            {error && errorTarget === "model" && (
              <p id={modelErrorId} role="alert" className="set-error">
                {error}
              </p>
            )}
            <div className="set-model-chips">
              {draft.models.map((m) => (
                <span key={m}>
                  {m}
                  <button
                    type="button"
                    aria-label={`移除模型 ${m}`}
                    onClick={() =>
                      change(
                        "models",
                        draft.models.filter((x) => x !== m),
                      )
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
            {!draft.models.length && (
              <p className="set-caption">
                尚未添加模型，至少添加一个后才能保存。
              </p>
            )}
            <details className="settings-api-review">
              <summary>模型目录演示选项</summary>
              <label className="set-test-simulation">
                <input
                  type="checkbox"
                  checked={fetchFail}
                  onChange={(e) => setFetchFail(e.target.checked)}
                />
                演示模型列表读取失败
              </label>
            </details>
            {fetchError && (
              <Notice
                tone="warning"
                title="无法读取模型列表"
                action={<Button onClick={fetch}>重试</Button>}
              >
                已有模型仍保留。你也可以按服务文档手动添加模型 ID。
              </Notice>
            )}
            {catalog && (
              <div className="set-model-catalog">
                <div className="set-list-toolbar">
                  <label className="set-search">
                    <MagnifyingGlass size={15} />
                    <input
                      value={catalogQuery}
                      aria-label="搜索返回的模型"
                      onChange={(e) => setCatalogQuery(e.target.value)}
                      placeholder="搜索模型"
                    />
                  </label>
                  <Button
                    kind="icon"
                    aria-label="关闭模型列表"
                    onClick={() => setCatalog(null)}
                  >
                    <X size={17} />
                  </Button>
                </div>
                <div className="set-model-options">
                  {catalog
                    .filter((m) =>
                      m.toLowerCase().includes(catalogQuery.toLowerCase()),
                    )
                    .map((m) => (
                      <label key={m}>
                        <input
                          type="checkbox"
                          checked={
                            draft.models.includes(m) || selected.includes(m)
                          }
                          disabled={draft.models.includes(m)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked
                                ? [...s, m]
                                : s.filter((x) => x !== m),
                            )
                          }
                        />
                        <span>{m}</span>
                        {draft.models.includes(m) && <small>已添加</small>}
                      </label>
                    ))}
                </div>
                <div className="set-model-catalog-footer">
                  <span>列表可读取，不代表每个模型均可用。</span>
                  <Button
                    primary
                    disabled={!selected.length}
                    onClick={() => {
                      change("models", [
                        ...new Set([...draft.models, ...selected]),
                      ]);
                      setCatalog(null);
                      setSelected([]);
                    }}
                  >
                    添加选中的 {selected.length} 个模型
                  </Button>
                </div>
              </div>
            )}
          </section>
          {affected && (
            <Notice
              tone="warning"
              title={
                item.uses
                  ? `会影响 ${item.uses} 个已有对话的后续发送`
                  : "已有对话继续保留原来源"
              }
            >
              更换地址、接口或移除模型不会给旧对话换来源。若要同时保留原配置，请取消并添加另一份配置。
            </Notice>
          )}
          <ApiTest
            key={`${draft.revision}:${keyReady}`}
            contextKey={`${draft.revision}:${keyReady}`}
            models={draft.models}
            ready={ready && !saving}
          />
          <details className="settings-api-review">
            <summary>保存演示选项</summary>
            <label>
              <input
                type="checkbox"
                checked={saveFail}
                onChange={(e) => setSaveFail(e.target.checked)}
              />{" "}
              模拟保存失败，保留原配置
            </label>
          </details>
          {error && errorTarget !== "model" && (
            <p
              ref={generalErrorRef}
              tabIndex={-1}
              role="alert"
              className="set-error"
              style={{ scrollMarginBlock: "24px" }}
            >
              {error}
            </p>
          )}
        </fieldset>
      </Modal>
      {discard && (
        <Confirm
          title="放弃未保存的修改？"
          confirm="放弃修改"
          onClose={() => setDiscard(false)}
          onConfirm={onClose}
        >
          <p>当前表单尚未保存。关闭后只保留上次保存的配置。</p>
        </Confirm>
      )}
    </>
  );
}

export default function Api({
  toast = () => {},
  fromAgent,
  onAgentReturn,
  services: sharedServices,
  onServicesChange,
  tasks = [],
  agents = AGENT_CATALOG,
}) {
  const [localServices, setLocalServices] = useState(() =>
    clone(START_SERVICES),
  );
  const sourceServices = sharedServices ?? localServices;
  const services = sourceServices.map((service) => {
    const conversations = serviceConversations(service, tasks);
    return { ...service, uses: conversations.length, conversations };
  });
  const sourceRef = useRef(sourceServices);
  sourceRef.current = sourceServices;
  const setServices = (update) => {
    const next =
      typeof update === "function" ? update(sourceRef.current) : update;
    sourceRef.current = next;
    setLocalServices(next);
    onServicesChange?.(next);
  };
  useEffect(() => {
    if (!sharedServices) onServicesChange?.(localServices);
  }, []);
  const [editor, setEditor] = useState(undefined);
  const [test, setTest] = useState(null);
  const [remove, setRemove] = useState(null);
  const [query, setQuery] = useState("");
  const filteredServices = filterApiServices(services, query);
  const [scene, setScene] = useState("saved");
  const [missing, setMissing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFail, setDeleteFail] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteTimer = useRef(null);
  useEffect(() => () => clearTimeout(deleteTimer.current), []);
  const removeService = () => {
    if (!remove || deleteBusy) return;
    const target = remove;
    setDeleteBusy(true);
    setDeleteError("");
    setTest(null);
    setServices((items) =>
      items.map((item) =>
        item.id === target.id ? { ...item, deleting: true } : item,
      ),
    );
    deleteTimer.current = setTimeout(() => {
      setDeleteBusy(false);
      if (deleteFail) {
        setDeleteError(
          "演示清理失败，配置已停止供新任务选择。可重试删除，历史仍保留。",
        );
        return;
      }
      setServices((items) => items.filter((item) => item.id !== target.id));
      if (target.uses) setMissing(true);
      setRemove(null);
      toast("已删除演示配置 · 历史与进行中的工作保留");
    }, 400);
  };
  const save = (item) => {
    setServices((items) =>
      items.some((x) => x.id === item.id)
        ? items.map((x) => (x.id === item.id ? item : x))
        : [...items, item],
    );
    setEditor(undefined);
    setTest(null);
    setScene("saved");
    toast("配置已保存到演示列表 · 未发送给任何 Agent");
  };
  return (
    <div className="settings-api">
      <PageHeading
        title="API 配置"
        description="保存一次，在兼容的 Agent 中选择使用。"
      >
        <Button primary onClick={() => setEditor(null)}>
          <Plus size={17} />
          添加 API
        </Button>
      </PageHeading>
      {fromAgent && (
        <Notice
          title="继续设置模型来源"
          action={
            <Button onClick={onAgentReturn}>
              <ArrowLeft size={15} />
              返回 Agent
            </Button>
          }
        >
          保存后返回新对话选择服务。API 配置与 Agent 账号登录是两件事。
        </Notice>
      )}
      <details className="settings-api-review">
        <summary>服务列表演示选项</summary>
        <ReviewScenario
          value={scene}
          onChange={(v) => {
            if (v === "empty") setServices([]);
            if (v === "restore") setServices(clone(START_SERVICES));
            setScene(v === "restore" ? "saved" : v);
            setMissing(false);
          }}
          items={[
            ["saved", "当前配置 · 保留更改"],
            ["empty", "清空配置 · 演示空态"],
            ["restore", "恢复内置示例 · 覆盖当前配置"],
            ["read-failed", "列表读取失败"],
          ]}
        />
        <label>
          <input
            type="checkbox"
            checked={deleteFail}
            onChange={(e) => setDeleteFail(e.target.checked)}
          />{" "}
          模拟删除清理失败
        </label>
        <p className="set-save-hint">
          读取失败不删除配置；清空和恢复仅修改本地演示。
        </p>
      </details>
      {scene === "read-failed" ? (
        <Notice
          tone="warning"
          title="无法读取 API 配置"
          action={<Button onClick={() => setScene("saved")}>重试</Button>}
        >
          已有设置不会丢失，稍后可以重新读取。
        </Notice>
      ) : (
        <>
          {(services.length > 2 || query) && (
            <label className="set-search set-api-search">
              <MagnifyingGlass size={17} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索配置或模型"
                aria-label="搜索 API 配置"
              />
            </label>
          )}
          {!services.length ? (
            <Empty
              icon={Key}
              title="添加你的模型服务"
              action={
                <Button primary onClick={() => setEditor(null)}>
                  <Plus size={16} />
                  添加 API 配置
                </Button>
              }
            >
              已有 Agent 账号可以继续使用。只有想使用自己的 API
              时，才需要在这里添加。
            </Empty>
          ) : !filteredServices.length ? (
            <Empty
              icon={MagnifyingGlass}
              title="没有匹配的配置"
              action={<Button onClick={() => setQuery("")}>清除搜索</Button>}
            >
              换个配置名称、提供方或模型试试。
            </Empty>
          ) : (
            <div className="set-service-list">
              {filteredServices.map((s) => (
                <article className="set-service" key={s.id}>
                  <div className="set-service-heading">
                    <span className="set-key-icon">
                      <Key size={24} />
                    </span>
                    <div>
                      <h3>{s.name}</h3>
                      <p>
                        {s.provider || "自定义来源"} · {FORMAT_NAMES[s.format]}
                      </p>
                    </div>
                    <Badge tone={s.deleting ? "warning" : "purple"}>
                      {s.deleting ? "删除未完成" : "已保存"}
                    </Badge>
                  </div>
                  <p className="set-service-url">{s.endpoint}</p>
                  <div className="set-model-chips">
                    {s.models.map((m) => (
                      <span key={m}>{m}</span>
                    ))}
                  </div>
                  <div className="set-service-use">
                    <span>
                      {compatibleAgents(s, agents).length
                        ? "可供以下 Agent 选择"
                        : "当前 Agent 尚不能选择这种接口"}
                    </span>
                    {compatibleAgents(s, agents).map(({ name }) => (
                      <span className="set-compatible" key={name}>
                        <AgentIcon name={name} size={16} />
                        {name}
                      </span>
                    ))}
                  </div>
                  <div className="set-service-actions">
                    <Button disabled={s.deleting} onClick={() => setEditor(s)}>
                      编辑
                    </Button>
                    <Button
                      onClick={() => setTest(test === s.id ? null : s.id)}
                      disabled={s.deleting}
                      aria-expanded={test === s.id}
                    >
                      测试 API <CaretDown size={13} />
                    </Button>
                    <Button
                      className="set-danger-text"
                      onClick={() => {
                        setRemove(s);
                        setDeleteError("");
                      }}
                    >
                      {s.deleting ? "重试删除" : "删除"}
                    </Button>
                    <small>
                      {s.uses
                        ? `${s.uses} 个示例对话使用此来源`
                        : "尚无示例对话使用此来源"}
                    </small>
                  </div>
                  {test === s.id && (
                    <ApiTest
                      key={`${s.id}:${s.revision}`}
                      models={s.models}
                      contextKey={`${s.id}:${s.revision}`}
                      ready={s.demoKey !== false && !s.deleting}
                    />
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {missing && (
        <Notice
          tone="warning"
          title="已有对话的来源已被删除"
          action={<Button onClick={() => setMissing(false)}>知道了</Button>}
        >
          历史仍保留，后续发送暂停。不能自动替换成同名模型或另一个服务。
        </Notice>
      )}
      <div className="set-api-explainer">
        <ShieldCheck size={20} />
        <div>
          <strong>保存、测试、实际使用，分别确认</strong>
          <p>
            保存不会自动交付密钥。开始新对话时选择兼容服务与模型，已有对话保持原来源。
          </p>
        </div>
      </div>
      {editor !== undefined && (
        <ServiceEditor
          service={editor}
          services={sourceServices}
          agents={agents}
          onCancel={() => setEditor(undefined)}
          onSave={save}
        />
      )}
      {remove && (
        <Modal
          title={`删除「${remove.name}」？`}
          onClose={() => {
            if (!deleteBusy) setRemove(null);
          }}
          footer={
            <>
              <Button disabled={deleteBusy} onClick={() => setRemove(null)}>
                {deleteError ? "稍后重试" : "取消"}
              </Button>
              <Button
                disabled={deleteBusy}
                className="set-danger"
                onClick={removeService}
              >
                {deleteBusy
                  ? "正在删除…"
                  : deleteError
                    ? "重试删除"
                    : "删除配置"}
              </Button>
            </>
          }
        >
          {deleteError && (
            <p role="alert" className="set-error">
              {deleteError}
            </p>
          )}
          <p>
            这个来源将不再可选。进行中的任务不会因此立刻停止，也不会在提供方撤销密钥，或收回执行过程中已经交付的凭据副本。
          </p>
          {remove.uses > 0 && (
            <div className="set-impact">
              <strong>{remove.uses} 个对话的后续发送会暂停</strong>
              {remove.conversations.map((task) => (
                <p key={task.id}>{task.title}</p>
              ))}
            </div>
          )}
          <p className="set-caption">删除本地密钥不等于服务商已撤销密钥。</p>
        </Modal>
      )}
    </div>
  );
}
