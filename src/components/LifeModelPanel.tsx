import { useEffect, useRef, useState } from "react";
import { Brain, Check, Prohibit, Trash, X } from "@phosphor-icons/react";
import type {
  CreateProposalInput,
  LifeModelCategory,
  LifeModelProposal,
  LifeModelSnapshot,
  LifeModelSourceCandidate,
  UpdateProposalInput,
} from "../runtime/lifemodel";

interface LifeModelPanelProps {
  snapshot: LifeModelSnapshot | null;
  candidates: LifeModelSourceCandidate[];
  selectedItemIds: string[];
  unavailable: string | null;
  busy: boolean;
  onClose: () => void;
  onReload: () => void;
  onCreate: (input: CreateProposalInput) => void;
  onUpdate: (input: UpdateProposalInput) => void;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onDelete: (itemId: string) => void;
  onWithdrawSource: (itemId: string, sourceId: string) => void;
  onEnabled: (enabled: boolean) => void;
  onSelectItem: (itemId: string, selected: boolean) => void;
}

const categoryLabels: Record<LifeModelCategory, string> = {
  preference: "偏好",
  identity: "身份",
  goal: "目标",
};

function runtimeLabel(runtimeProductId: string): string {
  if (runtimeProductId === "opencode") return "OpenCode";
  if (runtimeProductId === "pi") return "Pi";
  return runtimeProductId;
}

function ProposalCard({
  proposal,
  busy,
  onUpdate,
  onApprove,
  onReject,
}: {
  proposal: LifeModelProposal;
  busy: boolean;
  onUpdate: (input: UpdateProposalInput) => void;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
}) {
  const [category, setCategory] = useState(proposal.category);
  const [key, setKey] = useState(proposal.key);
  const [after, setAfter] = useState(proposal.after);
  const [reason, setReason] = useState(proposal.reason);
  const dirty =
    category !== proposal.category ||
    key !== proposal.key ||
    after !== proposal.after ||
    reason !== proposal.reason;
  const pending = proposal.decision === "pending";
  const materialized = proposal.materialization === "materialized";
  const conflictsWithCanonical =
    proposal.before !== null && proposal.before !== proposal.after;

  return (
    <article className={`lifemodel-card proposal ${proposal.decision}`}>
      <header>
        <span>{categoryLabels[proposal.category]}</span>
        <em>
          {proposal.decision === "pending"
            ? "待决定"
            : proposal.decision === "rejected"
              ? "已拒绝"
              : materialized
                ? "已批准 · 已写入"
                : "已批准 · 未写入"}
        </em>
      </header>
      {pending ? (
        <div className="lifemodel-edit-grid">
          <select
            aria-label="Proposal 类别"
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as LifeModelCategory)
            }
            disabled={busy}
          >
            <option value="preference">偏好</option>
            <option value="identity">身份</option>
            <option value="goal">目标</option>
          </select>
          <input
            aria-label="Proposal 键"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
          />
          <textarea
            aria-label="Proposal 修改后内容"
            value={after}
            onChange={(event) => setAfter(event.target.value)}
            disabled={busy}
          />
          <input
            aria-label="Proposal 理由"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={busy}
          />
        </div>
      ) : (
        <p className="lifemodel-card-value">{proposal.after}</p>
      )}
      <dl className="lifemodel-diff">
        <div>
          <dt>Before</dt>
          <dd>{proposal.before ?? "尚无 canonical 值"}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>{proposal.after}</dd>
        </div>
      </dl>
      {pending && conflictsWithCanonical && (
        <p className="lifemodel-conflict" role="status">
          此来源与当前 canonical 值冲突。除非你明确批准，否则不会覆盖现有值。
        </p>
      )}
      <details>
        <summary>来源与 Provider 预览</summary>
        <p>{proposal.source.sourceText}</p>
        <small>
          {runtimeLabel(proposal.source.runtimeProductId)} Session{" "}
          {proposal.source.nativeSessionId} · Entry{" "}
          {proposal.source.nativeEntryId}
        </small>
        <pre>{proposal.providerPayloadPreview}</pre>
      </details>
      {pending && (
        <footer>
          {dirty && (
            <button
              onClick={() =>
                onUpdate({
                  proposalId: proposal.id,
                  category,
                  key,
                  after,
                  reason,
                })
              }
              disabled={busy || !key.trim() || !after.trim() || !reason.trim()}
            >
              保存编辑
            </button>
          )}
          <button
            className="proposal-reject"
            onClick={() => onReject(proposal.id)}
            disabled={busy}
          >
            <Prohibit size={14} /> 拒绝
          </button>
          <button
            className="proposal-approve"
            onClick={() => onApprove(proposal.id)}
            disabled={busy || dirty}
            title={dirty ? "请先保存编辑，再批准" : undefined}
          >
            <Check size={14} /> 批准并写入
          </button>
        </footer>
      )}
    </article>
  );
}

export function LifeModelPanel({
  snapshot,
  candidates,
  selectedItemIds,
  unavailable,
  busy,
  onClose,
  onReload,
  onCreate,
  onUpdate,
  onApprove,
  onReject,
  onDelete,
  onWithdrawSource,
  onEnabled,
  onSelectItem,
}: LifeModelPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [candidateId, setCandidateId] = useState("");
  const [category, setCategory] = useState<LifeModelCategory>("preference");
  const [key, setKey] = useState("");
  const [after, setAfter] = useState("");
  const [reason, setReason] = useState(
    "用户明确选择该陈述作为 LifeModel 候选。",
  );
  const candidate = candidates.find((item) => item.candidateId === candidateId);
  useEffect(() => {
    closeButton.current?.focus();

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;

      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      );
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!first || !last) return;

      const active = document.activeElement;
      if (!panel.current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleDialogKeyDown);
    return () => window.removeEventListener("keydown", handleDialogKeyDown);
  }, [onClose]);
  useEffect(() => {
    if (
      candidateId &&
      candidates.some((item) => item.candidateId === candidateId)
    )
      return;
    setCandidateId(candidates.at(-1)?.candidateId ?? "");
  }, [candidateId, candidates]);

  useEffect(() => {
    if (!candidate) return;
    setAfter(candidate.sourceText);
  }, [candidate]);

  function createProposal() {
    if (!candidate || !key.trim() || !after.trim() || !reason.trim()) return;
    onCreate({
      category,
      key,
      after,
      reason,
      source: {
        runtimeProductId: candidate.runtimeProductId,
        runtimeInstallationId: candidate.runtimeInstallationId,
        runtimeAdapterId: candidate.runtimeAdapterId,
        nativeSessionId: candidate.nativeSessionId,
        nativeEntryId: candidate.nativeEntryId,
        nativeTimestamp: candidate.nativeTimestamp,
        sourceText: candidate.sourceText,
      },
    });
    setKey("");
  }

  return (
    <div className="settings-overlay" role="presentation">
      <section
        ref={panel}
        className="lifemodel-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lifemodel-title"
      >
        <header>
          <div>
            <span className="settings-eyebrow">User-governed context</span>
            <h2 id="lifemodel-title">
              <Brain size={21} /> LifeModel
            </h2>
            <p>
              来源先成为 Proposal；只有你的批准才会写入 canonical LifeModel。
            </p>
          </div>
          <div className="lifemodel-header-actions">
            {snapshot && (
              <label className="lifemodel-switch">
                <input
                  type="checkbox"
                  checked={snapshot.enabled}
                  onChange={(event) => onEnabled(event.target.checked)}
                  disabled={busy}
                />
                {snapshot.enabled ? "已启用" : "已停用"}
              </label>
            )}
            <button
              ref={closeButton}
              className="settings-close"
              onClick={onClose}
              aria-label="关闭 LifeModel"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {unavailable ? (
          <div className="lifemodel-unavailable" role="alert">
            <strong>LifeModel 当前不可用</strong>
            <p>{unavailable}</p>
            <p>普通 Agent Runtime 对话仍可继续使用。</p>
            <button onClick={onReload}>重试读取</button>
          </div>
        ) : !snapshot ? (
          <div className="lifemodel-unavailable">正在读取本地 LifeModel…</div>
        ) : (
          <div className="lifemodel-columns">
            <section className="lifemodel-column sources">
              <header>
                <span>1</span>
                <div>
                  <h3>选择来源</h3>
                  <p>仅列出本次运行中已完成的用户消息。</p>
                </div>
              </header>
              <div className="lifemodel-source-list">
                {candidates.length ? (
                  candidates
                    .slice()
                    .reverse()
                    .map((source) => (
                      <button
                        className={
                          source.candidateId === candidateId ? "selected" : ""
                        }
                        key={source.candidateId}
                        onClick={() => setCandidateId(source.candidateId)}
                      >
                        <span>{source.sourceText}</span>
                        <small>
                          {runtimeLabel(source.runtimeProductId)} ·{" "}
                          {source.nativeSessionId.slice(0, 8)} ·{" "}
                          {source.nativeEntryId}
                        </small>
                      </button>
                    ))
                ) : (
                  <p className="lifemodel-empty">
                    完成一轮支持贡献的 Runtime
                    对话后，可在这里选择明确的偏好、身份或目标陈述。
                  </p>
                )}
              </div>
              {candidate && (
                <div className="lifemodel-proposal-form">
                  <select
                    value={category}
                    onChange={(event) =>
                      setCategory(event.target.value as LifeModelCategory)
                    }
                    disabled={busy}
                  >
                    <option value="preference">偏好</option>
                    <option value="identity">身份</option>
                    <option value="goal">目标</option>
                  </select>
                  <input
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="稳定键，例如 answer_style"
                    aria-label="LifeModel 稳定键"
                    disabled={busy}
                  />
                  <textarea
                    value={after}
                    onChange={(event) => setAfter(event.target.value)}
                    aria-label="提议写入的值"
                    disabled={busy}
                  />
                  <input
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    aria-label="提议理由"
                    disabled={busy}
                  />
                  <button
                    className="lifemodel-primary"
                    onClick={createProposal}
                    disabled={busy || !key.trim() || !after.trim()}
                  >
                    创建 Proposal
                  </button>
                </div>
              )}
            </section>

            <section className="lifemodel-column proposals">
              <header>
                <span>2</span>
                <div>
                  <h3>检查 Proposal</h3>
                  <p>编辑 before/after，再明确批准或拒绝。</p>
                </div>
              </header>
              <div className="lifemodel-card-list">
                {snapshot.proposals.length ? (
                  snapshot.proposals
                    .slice()
                    .reverse()
                    .map((proposal) => (
                      <ProposalCard
                        key={proposal.id}
                        proposal={proposal}
                        busy={busy}
                        onUpdate={onUpdate}
                        onApprove={onApprove}
                        onReject={onReject}
                      />
                    ))
                ) : (
                  <p className="lifemodel-empty">尚无 Proposal。</p>
                )}
              </div>
            </section>

            <section className="lifemodel-column canonical">
              <header>
                <span>3</span>
                <div>
                  <h3>Canonical LifeModel</h3>
                  <p>最多选择 3 项，仅用于下一条新消息。</p>
                </div>
              </header>
              <div className="lifemodel-card-list">
                {snapshot.items.length ? (
                  snapshot.items.map((item) => {
                    const selected = selectedItemIds.includes(item.id);
                    const supportingSourceIds = new Set(
                      snapshot.proposals
                        .filter(
                          (proposal) =>
                            proposal.decision === "approved" &&
                            proposal.category === item.category &&
                            proposal.key === item.key &&
                            proposal.after === item.value,
                        )
                        .map((proposal) => proposal.source.id),
                    );
                    const activeSupportCount = item.sources.filter((source) =>
                      supportingSourceIds.has(source.id),
                    ).length;
                    return (
                      <article
                        className="lifemodel-card canonical"
                        key={item.id}
                      >
                        <header>
                          <span>{categoryLabels[item.category]}</span>
                          <label>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={
                                busy ||
                                !snapshot.enabled ||
                                (!selected && selectedItemIds.length >= 3)
                              }
                              onChange={(event) =>
                                onSelectItem(item.id, event.target.checked)
                              }
                            />
                            下一条使用
                          </label>
                        </header>
                        <strong>{item.key}</strong>
                        <p className="lifemodel-card-value">{item.value}</p>
                        <small>
                          {item.sources.length} 个来源 · Proposal{" "}
                          {item.proposalId}
                        </small>
                        <details className="lifemodel-source-provenance">
                          <summary>查看与撤销来源</summary>
                          {item.sources.map((source) => (
                            <div key={source.id}>
                              <span>
                                {runtimeLabel(source.runtimeProductId)} ·{" "}
                                {source.nativeSessionId} ·{" "}
                                {source.nativeEntryId}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  onWithdrawSource(item.id, source.id)
                                }
                                disabled={
                                  busy ||
                                  (supportingSourceIds.has(source.id) &&
                                    activeSupportCount <= 1)
                                }
                                title={
                                  supportingSourceIds.has(source.id) &&
                                  activeSupportCount <= 1
                                    ? "最后一个来源不能静默撤销；如需移除，请删除整个 canonical item"
                                    : "仅撤销该来源与 canonical item 的关联；不会修改 Runtime 原生历史"
                                }
                              >
                                撤销关联
                              </button>
                            </div>
                          ))}
                        </details>
                        <footer>
                          <button
                            className="lifemodel-delete"
                            onClick={() => onDelete(item.id)}
                            disabled={busy}
                          >
                            <Trash size={13} /> 删除
                          </button>
                        </footer>
                      </article>
                    );
                  })
                ) : (
                  <p className="lifemodel-empty">
                    只有已批准且已物化的 Proposal 才会出现在这里。
                  </p>
                )}
              </div>
              {snapshot.injectionManifests.length > 0 && (
                <details className="lifemodel-manifests">
                  <summary>最近 Injection Manifests</summary>
                  {snapshot.injectionManifests
                    .slice(-5)
                    .reverse()
                    .map((manifest) => (
                      <div key={manifest.id}>
                        <span>{manifest.status}</span>
                        <small>
                          {runtimeLabel(manifest.runtimeProductId)} ·{" "}
                          {manifest.itemIds.length} 项 ·{" "}
                          {new Date(manifest.createdAt).toLocaleString("zh-CN")}
                        </small>
                      </div>
                    ))}
                </details>
              )}
              {snapshot.sourceWithdrawals.length > 0 && (
                <details className="lifemodel-manifests">
                  <summary>已撤销的来源关联</summary>
                  {snapshot.sourceWithdrawals
                    .slice(-5)
                    .reverse()
                    .map((withdrawal) => (
                      <div key={withdrawal.id}>
                        <span>{runtimeLabel(withdrawal.runtimeProductId)}</span>
                        <small>
                          {withdrawal.nativeSessionId} ·{" "}
                          {withdrawal.nativeEntryId} ·{" "}
                          {new Date(withdrawal.createdAt).toLocaleString(
                            "zh-CN",
                          )}
                        </small>
                      </div>
                    ))}
                </details>
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
