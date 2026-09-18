import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";

interface TopBarProps {
  connected: AgentCardModel[];
}

export function TopBar({ connected }: TopBarProps) {
  const first = connected[0] ?? null;
  const identity = first ? agentIdentity(first.id, first.name) : null;
  return (
    <div className="topbar">
      <div className="title">{STRINGS.topbar.newChatTitle}</div>
      <button
        className="switcher"
        type="button"
        disabled
        aria-disabled="true"
        title={STRINGS.sidebar.comingSoon}
      >
        {first && identity ? (
          <>
            <span className={`id ${identity.cls}`}>{identity.letter}</span>
            {first.name}
          </>
        ) : (
          <span className="switcher-empty">
            {STRINGS.topbar.noAgentConnected}
          </span>
        )}
        <span className="chev">▾</span>
      </button>
    </div>
  );
}
