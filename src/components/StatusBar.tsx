/**
 * 底栏（F 稿 statusbar）：事件流状态、需要你/在跑计数、项目路径、
 * Agent 与版本、token 用量、应用版本。
 */
import type { AgentCardModel } from "../runtime/agents";
import {
  threads,
  useThreadsSnapshot,
  type ThreadState,
} from "../runtime/sessions";
import { STRINGS } from "../runtime/strings";

export function StatusBar({
  thread,
  agents,
  version,
}: {
  thread: ThreadState | null;
  agents: AgentCardModel[];
  version: string;
}) {
  const snapshot = useThreadsSnapshot();
  const all = [...snapshot.threads.values()];
  const needCount = all.filter((t) => threads.needsAttention(t)).length;
  const runCount = all.filter((t) => t.running).length;
  const lostCount = all.filter((t) => t.connectionLost).length;
  const agent = thread
    ? (agents.find((a) => a.id === thread.agentId) ?? null)
    : null;

  return (
    <footer className="statusbar">
      <div className="seg">
        <span>
          {lostCount > 0 ? (
            <>
              <i className="warn-dot" />
              {STRINGS.statusbar.streamLost}
            </>
          ) : (
            <>
              <i className="ok-dot" />
              {STRINGS.statusbar.streamOk}
            </>
          )}
        </span>
        {needCount > 0 && (
          <span className="need">{STRINGS.statusbar.needCount(needCount)}</span>
        )}
        {runCount > 0 && <span>{STRINGS.statusbar.runCount(runCount)}</span>}
        {needCount === 0 && runCount === 0 && (
          <span>{STRINGS.statusbar.idle}</span>
        )}
      </div>
      <div className="seg">
        {thread && <span className="t-path">{thread.cwd}</span>}
        {agent && (
          <span>
            {agent.name}
            {agent.version ? ` ${agent.version}` : ""}
          </span>
        )}
        {thread?.usage && (
          <span>
            {STRINGS.statusbar.tokens(thread.usage.used, thread.usage.size)}
          </span>
        )}
        <span>{STRINGS.statusbar.version(version)}</span>
      </div>
    </footer>
  );
}
