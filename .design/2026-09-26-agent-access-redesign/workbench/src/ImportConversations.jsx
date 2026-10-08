import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  Check,
  CheckCircle,
  CircleNotch,
  FolderSimple,
  MagnifyingGlass,
  WarningCircle,
  ChatCircleText,
} from "@phosphor-icons/react";
import { AgentIcon, Badge, Button, Modal } from "./ui";
import {
  IMPORT_STATUS,
  captureImportIdentity,
  createImportOperation,
  importAgentReady,
  joinedImportTasks,
  visibleImportPreview,
  addedImportAgents,
  filterImportRecords,
  importedKey,
  initialImportDraft,
  isImportable,
  lookupExample,
  planImport,
  toggleVisibleSelection,
} from "./import-state.js";
import "./import-conversations.css";
import "./settings-redesign.css";

export default function ImportConversations({
  open = true,
  agents = [],
  tasks = [],
  initialAgent,
  requestId,
  onClose,
  onImport,
  onOpen,
  onExplore,
  onNew,
}) {
  const available = addedImportAgents(agents);
  const [agentId, setAgentId] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [previewChecks, setPreviewChecks] = useState({});
  const filteredAgents = available.filter((item) =>
    item.name
      .toLocaleLowerCase()
      .includes(agentQuery.trim().toLocaleLowerCase()),
  );
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);
  const [attempts, setAttempts] = useState({});
  const [accepted, setAccepted] = useState([]);
  const operation = useRef(null);
  if (!operation.current) operation.current = createImportOperation(setBusy);
  const initialRequest = useRef(null);
  const latest = useRef({ tasks, accepted, agents });
  latest.current = { tasks, accepted, agents };
  const agent = available.find((item) => (item.id || item.name) === agentId);
  const agentReady = importAgentReady(agent);
  const draft = drafts[agentId] || initialImportDraft();
  const joined = joinedImportTasks(tasks, accepted);
  const knownTasks = [...joined.values()];
  const matchingRecords = filterImportRecords(draft.records, draft.query);
  const visible = matchingRecords.slice(0, draft.visibleCount || 3);
  const eligible = visible.filter((record) => isImportable(record, knownTasks));
  const selectedRecords = draft.records.filter(
    (record) =>
      draft.selected.includes(record.key) && isImportable(record, knownTasks),
  );
  const preview = visibleImportPreview(visible, draft.query, draft.previewId);
  const failures = draft.outcome?.failures || [];
  const setDraft = (patch, id = agentId) =>
    setDrafts((state) => ({
      ...state,
      [id]: { ...(state[id] || initialImportDraft()), ...patch },
    }));
  const cancelPending = () => {
    if (!operation.current.cancel()) return;
    setDrafts((state) =>
      Object.fromEntries(
        Object.entries(state).map(([id, value]) => [
          id,
          value.lookup === "loading"
            ? {
                ...value,
                lookup: value.records.length ? "loaded" : "idle",
                step: value.records.length ? 3 : 1,
              }
            : value,
        ]),
      ),
    );
  };
  const close = () => {
    cancelPending();
    onClose?.();
  };
  useEffect(() => {
    if (!open) {
      cancelPending();
      return;
    }
    const request = `${requestId ?? ""}|${initialAgent ?? ""}`;
    if (initialRequest.current === request) return;
    initialRequest.current = request;
    const preferred = available.find(
      (item) => item.id === initialAgent || item.name === initialAgent,
    );
    if (preferred) setAgentId(preferred.id || preferred.name);
  }, [open, initialAgent, requestId]);
  useEffect(() => () => operation.current.dispose(), []);
  useEffect(() => {
    const saved = new Set(tasks.map(importedKey).filter(Boolean));
    setAccepted((current) =>
      current.filter((task) => !saved.has(importedKey(task))),
    );
  }, [tasks]);

  const lookup = (example = draft.example) => {
    if (!agentReady) return;
    const id = agentId;
    const begun = operation.current.begin(
      "lookup",
      id,
      (currentOperation) => {
        const currentAgent = latest.current.agents.find(
          (item) => (item.id || item.name) === id,
        );
        const identity =
          draft.historyIdentity ||
          (currentAgent && captureImportIdentity(currentAgent));
        const result = lookupExample(currentAgent, example, identity, [
          ...joinedImportTasks(
            latest.current.tasks,
            latest.current.accepted,
          ).values(),
        ]);
        setDraft(
          {
            ...result,
            step: result.lookup === "loaded" ? 3 : 2,
            ...(result.records?.length ? { historyIdentity: identity } : {}),
            ...(result.records
              ? {
                  previewId: result.records.some(
                    (record) => record.externalId === draft.previewId,
                  )
                    ? draft.previewId
                    : result.records[0]?.externalId,
                }
              : {}),
          },
          id,
        );
        operation.current.finish(currentOperation);
      },
      650,
    );
    if (begun) setDraft({ example, lookup: "loading", step: 2 });
  };
  const importSelected = (
    keys = selectedRecords.map((record) => record.key),
  ) => {
    if (!agentReady || !keys.length) return;
    const id = agentId,
      records = draft.records;
    operation.current.begin(
      "import",
      id,
      async (currentOperation) => {
        const currentAgent = latest.current.agents.find(
          (item) => (item.id || item.name) === id,
        );
        if (!importAgentReady(currentAgent)) {
          setDraft(
            {
              outcome: {
                tasks: [],
                skipped: [],
                failures: keys.map((key) => ({
                  key,
                  title:
                    records.find((record) => record.key === key)?.title ||
                    "对话",
                  message: "Agent 当前不可用，尚未加入。请完成连接后重试。",
                })),
              },
            },
            id,
          );
          operation.current.finish(currentOperation);
          return;
        }
        const outcome = planImport(
          records,
          keys,
          [
            ...joinedImportTasks(
              latest.current.tasks,
              latest.current.accepted,
            ).values(),
          ],
          attempts,
        );
        setAttempts(outcome.attempts);
        try {
          if (outcome.tasks.length) {
            if (!onImport) throw new Error("missing handler");
            operation.current.commit(currentOperation);
            await onImport(outcome.tasks);
            if (!operation.current.isCurrent(currentOperation)) return;
            const saved = joinedImportTasks(
              latest.current.tasks,
              latest.current.accepted,
            );
            setAccepted((current) => [
              ...current,
              ...outcome.tasks.filter((task) => !saved.has(importedKey(task))),
            ]);
          }
          if (!operation.current.isCurrent(currentOperation)) return;
          const completed = new Set([
            ...outcome.tasks.map(importedKey),
            ...outcome.skipped,
          ]);
          setDrafts((state) => ({
            ...state,
            [id]: {
              ...state[id],
              outcome,
              selected: (state[id]?.selected || []).filter(
                (key) => !completed.has(key),
              ),
            },
          }));
        } catch {
          if (!operation.current.isCurrent(currentOperation)) return;
          const saved = joinedImportTasks(
            latest.current.tasks,
            latest.current.accepted,
          );
          const confirmed = outcome.tasks.filter((task) =>
            saved.has(importedKey(task)),
          );
          const confirmedKeys = new Set(confirmed.map(importedKey));
          setDrafts((state) => ({
            ...state,
            [id]: {
              ...state[id],
              selected: (state[id]?.selected || []).filter(
                (key) => !confirmedKeys.has(key),
              ),
              outcome: {
                ...outcome,
                tasks: confirmed,
                failures: [
                  ...outcome.failures,
                  ...outcome.tasks
                    .filter((task) => !confirmedKeys.has(importedKey(task)))
                    .map((task) => ({
                      key: task.importKey,
                      title: task.title,
                      message: "未能加入列表，选择与正文已保留，请重试。",
                    })),
                ],
              },
            },
          }));
        } finally {
          operation.current.finish(currentOperation);
        }
      },
      450,
    );
  };
  const loadMore = () => {
    const owner = agentId;
    operation.current.begin(
      "more",
      owner,
      (op) => {
        setDraft({ visibleCount: (draft.visibleCount || 3) + 3 }, owner);
        operation.current.finish(op);
      },
      350,
    );
  };
  const recheckPreview = () => {
    if (!preview || !agentReady || busy) return;
    const key = preview.key;
    operation.current.begin(
      "preview",
      agentId,
      (op) => {
        setPreviewChecks((current) => ({
          ...current,
          [key]:
            preview.status === "unreadable"
              ? "重新读取仍未取得正文，请稍后重试；没有加入空对话。"
              : preview.status === "missingLocation"
                ? "正文可读，但原位置仍不可用。可只读加入，或另开一段对话。"
                : "正文可读，仍未能确认原来源与模型；这条对话继续保持只读。",
        }));
        operation.current.finish(op);
      },
      450,
    );
  };
  const choose = (record) =>
    setDraft({
      selected: draft.selected.includes(record.key)
        ? draft.selected.filter((key) => key !== record.key)
        : [...draft.selected, record.key],
    });
  const openJoined = (key) => {
    const task = joinedImportTasks(
      latest.current.tasks,
      latest.current.accepted,
    ).get(key);
    if (!task) return;
    close();
    onOpen?.(task);
  };
  if (!open) return null;
  const step = agent ? draft.step : 1;
  const onlyRetries =
    selectedRecords.length > 0 &&
    selectedRecords.every((record) =>
      failures.some((failure) => failure.key === record.key),
    );
  return (
    <div className="import-conversations">
      <Modal
        title="带入已有对话"
        wide
        onClose={close}
        footer={
          <div className="import-footer">
            <span>
              {busy === "committing"
                ? "加入已提交，关闭不会取消；结果会保留。"
                : busy === "import"
                  ? "正在准备加入，提交前仍可取消。"
                  : "取消会保留本次选择，可稍后回来。"}
            </span>
            <div>
              <Button onClick={close}>
                {busy === "committing"
                  ? "关闭"
                  : draft.outcome?.tasks?.length && !selectedRecords.length
                    ? "完成"
                    : "暂时离开"}
              </Button>
              {step === 1 ? (
                <Button
                  primary
                  disabled={!agentReady || Boolean(busy)}
                  onClick={() => lookup()}
                >
                  <MagnifyingGlass size={15} />
                  查找示例对话
                </Button>
              ) : (
                step === 3 && (
                  <Button
                    primary
                    disabled={
                      !agentReady || !selectedRecords.length || Boolean(busy)
                    }
                    onClick={() => importSelected()}
                  >
                    {(busy === "import" || busy === "committing") && (
                      <CircleNotch size={15} className="spin" />
                    )}
                    {onlyRetries ? "重试失败项" : "加入所选"}（
                    {selectedRecords.length}）
                  </Button>
                )
              )}
            </div>
          </div>
        }
      >
        <div className="import-proposal">
          <Badge>原型示例</Badge>
          <span>本地示例数据，不读取真实 Agent 历史。</span>
        </div>
        <ol className="import-steps" aria-label="带入步骤">
          {["选择 Agent", "查找", "预览与加入"].map((label, index) => (
            <li
              key={label}
              className={
                step === index + 1
                  ? "active"
                  : step > index + 1
                    ? "complete"
                    : ""
              }
              aria-current={step === index + 1 ? "step" : undefined}
            >
              <span>{step > index + 1 ? <Check size={12} /> : index + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        {agent && !agentReady && (
          <div
            className="import-outcome partial import-access-notice"
            role="status"
          >
            <WarningCircle size={18} />
            <div>
              <strong>这个 Agent 当前不可用</strong>
              <p>
                已读取的正文与选择保留。连接恢复前不能查找或加入；已加入的对话仍可打开查看。
              </p>
              {onExplore && (
                <Button
                  kind="text"
                  onClick={() => {
                    close();
                    onExplore(agent.name);
                  }}
                >
                  检查 Agent
                </Button>
              )}
            </div>
          </div>
        )}
        {step === 1 ? (
          <>
            <div className="import-heading">
              <h3>从哪个 Agent 带入？</h3>
              <p>
                已有对话继续使用原来的 Agent 和模型，加入时不会重新发送消息。
              </p>
            </div>
            {available.length > 0 && (
              <label className="import-search sl-import-agent-search">
                <MagnifyingGlass size={16} />
                <input
                  aria-label="搜索导入 Agent"
                  placeholder="按名称查找 Agent"
                  value={agentQuery}
                  onChange={(e) => setAgentQuery(e.target.value)}
                />
                <span>
                  {filteredAgents.length} / {available.length}
                </span>
              </label>
            )}
            {agent && (
              <p className="sl-search-scope">
                当前选择：{agent.name} · 查找后不会自动加入或发送
              </p>
            )}
            {!available.length ? (
              <div className="import-empty">
                <ChatCircleText size={26} />
                <strong>还没有已添加的 Agent</strong>
                <p>添加 Agent 后，再来选择要带入的对话。</p>
                {onExplore && (
                  <Button
                    onClick={() => {
                      close();
                      onExplore();
                    }}
                  >
                    去添加 Agent
                    <ArrowRight size={14} />
                  </Button>
                )}
              </div>
            ) : (
              <div className="import-agents">
                {filteredAgents.map((item) => (
                  <button
                    key={item.id || item.name}
                    className={
                      agentId === (item.id || item.name) ? "selected" : ""
                    }
                    aria-pressed={agentId === (item.id || item.name)}
                    disabled={Boolean(busy)}
                    onClick={() => setAgentId(item.id || item.name)}
                  >
                    <AgentIcon name={item.name} size={27} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {importAgentReady(item)
                          ? "已添加 · 查看示例"
                          : "已添加 · 需要先完成连接"}
                      </small>
                    </span>
                    {agentId === (item.id || item.name) && (
                      <CheckCircle size={18} />
                    )}
                  </button>
                ))}
              </div>
            )}
            {available.length > 0 && !filteredAgents.length && (
              <div className="import-empty compact">
                <strong>没有匹配的 Agent</strong>
                <p>试试名称中的其他词，当前选择仍保留。</p>
                <Button onClick={() => setAgentQuery("")}>清除搜索</Button>
              </div>
            )}
            {agent && (
              <label className="import-demo-control">
                预览查找状态
                <select
                  aria-label="预览查找状态"
                  value={draft.example}
                  onChange={(event) =>
                    setDraft({ example: event.target.value })
                  }
                >
                  <option value="normal">示例对话列表</option>
                  <option value="empty">没有已有对话</option>
                  <option value="unsupported">不提供历史列表</option>
                  <option value="error">列表读取失败</option>
                </select>
              </label>
            )}
          </>
        ) : (
          <>
            <div className="import-source-row">
              <div>
                <AgentIcon name={agent.name} size={21} />
                <strong>{agent.name}</strong>
                <span>已有对话 · 示例</span>
              </div>
              <Button
                kind="text"
                disabled={Boolean(busy)}
                onClick={() => setDraft({ step: 1 })}
              >
                <ArrowLeft size={13} />
                更换 Agent
              </Button>
            </div>
            {draft.lookup === "loading" ? (
              <div className="import-empty" role="status">
                <CircleNotch className="spin" size={25} />
                <strong>正在查找示例对话</strong>
                <p>这里只模拟查找过程，没有访问本机文件。</p>
              </div>
            ) : draft.lookup === "unsupported" ? (
              <div className="import-empty">
                <ChatCircleText size={27} />
                <strong>Agent 不提供已有对话列表</strong>
                <p>
                  这是能力限制的示例，不代表没有历史，也不能据此确认某条已知对话是否可恢复。
                </p>
                <div className="import-empty-actions">
                  <Button onClick={() => setDraft({ step: 1 })}>
                    选择其他 Agent
                  </Button>
                  {onNew && (
                    <Button
                      primary
                      onClick={() => {
                        close();
                        onNew();
                      }}
                    >
                      新开对话
                    </Button>
                  )}
                </div>
              </div>
            ) : draft.lookup === "failed" ? (
              <div className="import-empty">
                <WarningCircle size={27} />
                <strong>暂时无法读取对话列表</strong>
                <p>{draft.lookupError}</p>
                <Button
                  primary
                  disabled={!agentReady || Boolean(busy)}
                  onClick={() => lookup("normal")}
                >
                  <ArrowClockwise size={14} />
                  重试读取
                </Button>
                <small>重试保留已选项；需要 Agent 可用后才能继续。</small>
              </div>
            ) : (
              <>
                {draft.outcome && (
                  <div
                    className={`import-outcome ${failures.length ? "partial" : ""}`}
                    role="status"
                  >
                    {failures.length ? (
                      <WarningCircle size={18} />
                    ) : (
                      <CheckCircle size={18} />
                    )}
                    <div>
                      <strong>
                        {draft.outcome.tasks.length
                          ? `已加入 ${draft.outcome.tasks.length} 条对话`
                          : failures.length
                            ? "部分对话尚未加入"
                            : "所选对话都已加入"}
                        {failures.length ? `，${failures.length} 条未加入` : ""}
                      </strong>
                      <p>
                        {failures.length
                          ? "成功项不会重复加入。失败项保留选择，可单独重试。"
                          : "原正文和可继续状态已保留，没有自动发送任何消息。"}
                      </p>
                    </div>
                  </div>
                )}
                <div className="import-toolbar">
                  <label className="import-search">
                    <MagnifyingGlass size={16} />
                    <input
                      aria-label="搜索已有对话"
                      placeholder="搜索标题、摘要或位置"
                      value={draft.query}
                      onChange={(event) =>
                        setDraft({ query: event.target.value, visibleCount: 3 })
                      }
                    />
                  </label>
                  <Button
                    kind="text"
                    disabled={!agentReady || Boolean(busy)}
                    onClick={() => lookup("normal")}
                  >
                    <ArrowClockwise size={14} />
                    重新查找
                  </Button>
                </div>
                {!draft.records.length ? (
                  <div className="import-empty">
                    <ChatCircleText size={27} />
                    <strong>这个 Agent 暂时没有已有对话</strong>
                    <p>可以换一个 Agent，或稍后重新查找。</p>
                    <Button
                      disabled={!agentReady || Boolean(busy)}
                      onClick={() => lookup("normal")}
                    >
                      查看有对话的示例
                    </Button>
                  </div>
                ) : (
                  <div className="import-browser">
                    <section className="import-list" aria-label="可带入的对话">
                      <div className="import-selection">
                        <label>
                          <input
                            type="checkbox"
                            aria-label="全选当前可加入的对话"
                            checked={
                              eligible.length > 0 &&
                              eligible.every((record) =>
                                draft.selected.includes(record.key),
                              )
                            }
                            disabled={!eligible.length || Boolean(busy)}
                            onChange={() =>
                              setDraft({
                                selected: toggleVisibleSelection(
                                  draft.selected,
                                  visible,
                                  knownTasks,
                                ),
                              })
                            }
                          />
                          全选已显示的可加入项
                        </label>
                        <span>
                          已选 {selectedRecords.length} · 显示 {visible.length}/
                          {matchingRecords.length}
                        </span>
                        {draft.selected.length > 0 && (
                          <button
                            onClick={() => setDraft({ selected: [] })}
                            disabled={Boolean(busy)}
                          >
                            清空
                          </button>
                        )}
                      </div>
                      {!visible.length ? (
                        <div className="import-empty compact">
                          <strong>没有匹配的对话</strong>
                          <p>试试别的关键词；已有选择仍然保留。</p>
                          <Button onClick={() => setDraft({ query: "" })}>
                            清除搜索
                          </Button>
                        </div>
                      ) : (
                        visible.map((record) => {
                          const existing = joined.get(record.key),
                            failed = failures.find(
                              (failure) => failure.key === record.key,
                            ),
                            status = IMPORT_STATUS[record.status];
                          return (
                            <article
                              key={record.key}
                              className={`import-record ${preview?.key === record.key ? "previewing" : ""}`}
                            >
                              <input
                                type="checkbox"
                                aria-label={`选择 ${record.title}`}
                                checked={
                                  Boolean(existing) ||
                                  draft.selected.includes(record.key)
                                }
                                disabled={
                                  Boolean(existing) ||
                                  !isImportable(record) ||
                                  Boolean(busy)
                                }
                                onChange={() => choose(record)}
                              />
                              <div>
                                <button
                                  className="import-record-title"
                                  onClick={() =>
                                    setDraft({ previewId: record.externalId })
                                  }
                                >
                                  {record.title}
                                </button>
                                <p>{record.preview}</p>
                                <div className="import-record-meta">
                                  <Badge
                                    tone={existing ? "green" : status.tone}
                                  >
                                    {existing
                                      ? "已加入"
                                      : !agentReady &&
                                          record.status === "continuable"
                                        ? "等待连接"
                                        : status.label}
                                  </Badge>
                                  <span>{record.updated}</span>
                                </div>
                                {failed && !existing && (
                                  <div className="import-row-failure">
                                    <span>{failed.message}</span>
                                    <Button
                                      kind="text"
                                      disabled={!agentReady || Boolean(busy)}
                                      onClick={() =>
                                        importSelected([record.key])
                                      }
                                    >
                                      重试此条
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </article>
                          );
                        })
                      )}
                      {visible.length < matchingRecords.length && (
                        <Button
                          className="sl-import-more"
                          disabled={Boolean(busy)}
                          onClick={loadMore}
                        >
                          {busy === "more"
                            ? "加载中…"
                            : `加载更多示例（还有 ${matchingRecords.length - visible.length} 段）`}
                        </Button>
                      )}
                    </section>
                    <section
                      className="import-preview"
                      aria-label="对话正文预览"
                    >
                      {preview ? (
                        <>
                          <div className="import-preview-title">
                            <span>正文预览</span>
                            <h3>{preview.title}</h3>
                            <dl className="sl-import-facts">
                              <div>
                                <dt>正文</dt>
                                <dd>
                                  {preview.messages?.length
                                    ? "已读取"
                                    : "未取得"}
                                </dd>
                              </div>
                              <div>
                                <dt>继续能力</dt>
                                <dd>
                                  {preview.status === "continuable"
                                    ? "已确认可继续（示例）"
                                    : preview.status === "unreadable"
                                      ? "尚未核对"
                                      : "仅可查看，不能继续发送"}
                                </dd>
                              </div>
                              <div>
                                <dt>原模型</dt>
                                <dd>{preview.model}</dd>
                              </div>
                              <div>
                                <dt>原来源</dt>
                                <dd>{preview.source}</dd>
                              </div>
                            </dl>
                          </div>
                          <div className="import-location">
                            <FolderSimple size={14} />
                            <span>
                              {preview.folder || "没有指定文件位置，也可加入"}
                            </span>
                          </div>
                          {preview.reason && (
                            <div className="import-preview-note">
                              <WarningCircle size={15} />
                              <div>
                                <p>{preview.reason}</p>
                                <Button
                                  kind="text"
                                  disabled={!agentReady || Boolean(busy)}
                                  onClick={recheckPreview}
                                >
                                  {busy === "preview"
                                    ? "检查中…"
                                    : "重新检查这条对话"}
                                </Button>
                              </div>
                            </div>
                          )}
                          {previewChecks[preview.key] && (
                            <p className="sl-preview-check" role="status">
                              {previewChecks[preview.key]}（本地演示）
                            </p>
                          )}
                          {preview.status === "unreadable" ? (
                            <div className="import-empty compact">
                              <strong>正文暂不可读</strong>
                              <p>此条不能加入，也不会以空对话代替。</p>
                              <Button
                                kind="text"
                                onClick={recheckPreview}
                                disabled={!agentReady || Boolean(busy)}
                              >
                                重新读取这条正文
                              </Button>
                            </div>
                          ) : (
                            <div className="import-messages">
                              {preview.messages.map((message, index) => (
                                <div
                                  key={index}
                                  className={
                                    message.role === "user"
                                      ? "from-user"
                                      : "from-agent"
                                  }
                                >
                                  <strong>
                                    {message.role === "user"
                                      ? "你"
                                      : preview.agent}
                                  </strong>
                                  <p>{message.text}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          {!joined.has(preview.key) &&
                            isImportable(preview, knownTasks) && (
                              <div className="sl-preview-action">
                                <Button
                                  primary
                                  disabled={Boolean(busy) || !agentReady}
                                  onClick={() => choose(preview)}
                                >
                                  {draft.selected.includes(preview.key)
                                    ? "取消选择这条"
                                    : preview.status === "continuable"
                                      ? "选择这条对话"
                                      : "选择并保留为只读"}
                                </Button>
                                <small>
                                  只选择，点击底部“加入所选”后才加入列表。
                                </small>
                              </div>
                            )}
                          {joined.has(preview.key) && (
                            <Button onClick={() => openJoined(preview.key)}>
                              打开已加入的对话
                              <ArrowRight size={14} />
                            </Button>
                          )}
                          {preview.status === "missingLocation" && (
                            <small className="import-preview-foot">
                              加入后可在对话中选择示例位置并新开；不会改变原对话的位置。
                            </small>
                          )}
                        </>
                      ) : (
                        <div className="import-empty compact">
                          <p>选择一条对话，先看看正文。</p>
                        </div>
                      )}
                    </section>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
