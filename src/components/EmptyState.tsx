/**
 * 空态/开始页（F-start-empty）：项目选择 + Agent 选择 + 模型选择 +
 * 消息栏。Agent 选定后预开草稿会话以拿到模型选项；发送即把草稿变成
 * 真会话并切到会话页。
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { AgentPick, usableAgents } from "./AgentSwitcher";
import { ModelPicker } from "./ModelPicker";
import { Composer } from "./Composer";
import type { AgentCardModel } from "../runtime/agents";
import { promptCapabilities } from "../runtime/agents";
import {
  basename,
  modelConfigOption,
  threads,
  useThread,
  type PromptBlock,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

export function EmptyState({
  agents,
  defaultCwd,
  initialAgentId = null,
  onGoSettings,
  onStarted,
}: {
  agents: AgentCardModel[];
  defaultCwd: string | null;
  /** Agent preselected by the topbar switcher's「新会话」rows. */
  initialAgentId?: string | null;
  onGoSettings: () => void;
  onStarted: (key: string) => void;
}) {
  const usable = usableAgents(agents);
  const [cwd, setCwd] = useState<string | null>(defaultCwd);
  const [agentId, setAgentId] = useState<string | null>(initialAgentId);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const draft = useThread(draftKey);
  const draftKeyRef = useRef<string | null>(null);
  draftKeyRef.current = draftKey;

  // Agent+项目确定 → 预开草稿会话，拿到 configOptions（模型选项）。
  // 草稿不写索引；切换/离开时丢弃并记墓碑（B1：不再产生幽灵会话）。
  useEffect(() => {
    if (!agentId || !cwd) {
      setDraftKey(null);
      return;
    }
    let cancelled = false;
    setOpening(true);
    setDraftError(null);
    threads
      .open({ agentId, cwd })
      .then((state) => {
        if (cancelled) {
          void threads.discardDraft(state.key);
          return;
        }
        setDraftKey(state.key);
      })
      .catch((error) => {
        if (!cancelled) setDraftError(String(error));
      })
      .finally(() => {
        if (!cancelled) setOpening(false);
      });
    return () => {
      cancelled = true;
      const stale = draftKeyRef.current;
      if (stale) {
        draftKeyRef.current = null;
        void threads.discardDraft(stale);
      }
    };
  }, [agentId, cwd]);

  const modelOption = draft ? modelConfigOption(draft.configOptions) : null;
  const imageOk = promptCapabilities(
    agents.find((a) => a.id === agentId) ?? null,
  ).image;

  const pickProject = async () => {
    const picked = await openDialog({
      directory: true,
      defaultPath: cwd ?? undefined,
    });
    if (typeof picked === "string" && picked) setCwd(picked);
  };

  const send = async (blocks: PromptBlock[]) => {
    if (!agentId || !cwd) return;
    let key = draftKey;
    if (!key || !threads.thread(key)) {
      // Stale/discarded draft or the eager open still in flight — the
      // store dedupes a concurrent open for the same pair.
      const state = await threads.open({ agentId, cwd });
      key = state.key;
    }
    // Do not await: a prompt round can run long — the store already
    // pushed the user item and flipped `running` synchronously.
    void threads.send(key, blocks);
    onStarted(key);
  };

  const ready = agentId !== null && cwd !== null;
  const note = !cwd
    ? STRINGS.empty.projectRequired
    : !agentId
      ? STRINGS.empty.agentRequired
      : opening
        ? STRINGS.empty.opening
        : draftError
          ? `${STRINGS.empty.openFailed}：${draftError}`
          : null;

  return (
    <main className="main">
      <div className="topbar">
        <div className="title">{STRINGS.topbar.newChatTitle}</div>
      </div>
      <div className="empty-wrap">
        <div className="empty-col">
          {usable.length === 0 ? (
            <>
              <div className="empty-h">{STRINGS.empty.connectTitle}</div>
              <div className="empty-sub">{STRINGS.empty.connectSubtitle}</div>
              <div className="empty-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onGoSettings}
                >
                  {STRINGS.empty.goSettings}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="empty-h">{STRINGS.empty.readyTitle}</div>
              <div className="empty-sub">{STRINGS.empty.readySubtitle}</div>
              <div style={{ alignSelf: "stretch", marginTop: 8 }}>
                <div className="pick-label">{STRINGS.empty.projectLabel}</div>
                <button
                  type="button"
                  className="proj-pick"
                  onClick={() => void pickProject()}
                >
                  <span className="p-icon">📁</span>
                  <span className="p-path" title={cwd ?? ""}>
                    {cwd
                      ? `${basename(cwd)} · ${cwd}`
                      : STRINGS.empty.projectPick}
                  </span>
                </button>
              </div>
              <div style={{ alignSelf: "stretch", marginTop: 14 }}>
                <div className="pick-label">{STRINGS.empty.agentLabel}</div>
                <AgentPick
                  cards={agents}
                  picked={agentId}
                  onPick={setAgentId}
                  onGoSettings={onGoSettings}
                />
              </div>
              {agentId && (opening || modelOption) && (
                <div style={{ alignSelf: "stretch", marginTop: 14 }}>
                  <div className="pick-label">
                    {STRINGS.switcher.modelLabel}
                  </div>
                  {modelOption ? (
                    <ModelPicker
                      option={modelOption}
                      onPick={(value) => {
                        if (draft) {
                          void threads.setConfig(
                            draft.key,
                            modelOption.id,
                            value,
                          );
                        }
                      }}
                    />
                  ) : (
                    <div className="model-skel" aria-hidden="true" />
                  )}
                </div>
              )}
              <div style={{ alignSelf: "stretch", marginTop: 8 }}>
                <Composer
                  thread={draft}
                  imageEnabled={imageOk}
                  onGoSettings={onGoSettings}
                  onSend={send}
                  disabled={!ready || draftError !== null}
                  note={note}
                  noteAction={draftError !== null}
                  fit
                />
              </div>
              <div className="bind-note">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="11" width="18" height="10" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                {STRINGS.empty.bindNote}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
