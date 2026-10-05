import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import { isAgentReadyForConversation } from "../runtime/agent_directory";

/** Confirmed preparation remains selectable when its process is offline. */
export function usableAgents(
  cards: AgentCardModel[],
  prepared: (id: string) => boolean,
  enabled: (id: string) => boolean = () => true,
): AgentCardModel[] {
  return cards.filter(
    (c) => isAgentReadyForConversation(c, prepared(c.id)) && enabled(c.id),
  );
}

/** 开始页 Agent 选择行（F-start-empty .agent-pick）。 */
export function AgentPick({
  cards,
  enabled = () => true,
  picked,
  onPick,
  prepared,
}: {
  cards: AgentCardModel[];
  enabled?: (id: string) => boolean;
  picked: string | null;
  onPick: (id: string) => void;
  onGoSettings: (agentId?: string) => void;
  prepared: (agentId: string) => boolean;
}) {
  const usable = usableAgents(cards, prepared, enabled);
  return (
    <div className="agent-pick">
      {usable.map((card) => {
        const ident = agentIdentity(card.id, card.name);
        return (
          <button
            key={card.id}
            type="button"
            className={`pick${picked === card.id ? " on" : ""}`}
            onClick={() => {
              if (prepared(card.id)) onPick(card.id);
            }}
          >
            <span className={`id ${ident.cls}`}>{ident.letter}</span>
            <span className="p-name">{card.name}</span>
            <span className="p-model">
              <i className="p-dot" />
            </span>
          </button>
        );
      })}
    </div>
  );
}
