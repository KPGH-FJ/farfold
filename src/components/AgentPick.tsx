import type { AgentCardModel } from "../runtime/agents";
import { agentIdentity } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import { ACCESS_STRINGS } from "../runtime/access_strings";

/** 可被用来开会的 Agent：已注册或已连接；未接入的灰显。 */
export function usableAgents(
  cards: AgentCardModel[],
  enabled: (id: string) => boolean = () => true,
): AgentCardModel[] {
  return cards.filter(
    (c) =>
      enabled(c.id) &&
      (c.status === "installed" || c.status === "connected" || c.custom),
  );
}

/** 开始页 Agent 选择行（F-start-empty .agent-pick）。 */
export function AgentPick({
  cards,
  enabled = () => true,
  picked,
  onPick,
  onGoSettings,
  prepared = () => true,
}: {
  cards: AgentCardModel[];
  enabled?: (id: string) => boolean;
  picked: string | null;
  onPick: (id: string) => void;
  onGoSettings: (agentId?: string) => void;
  prepared?: (agentId: string) => boolean;
}) {
  const usable = usableAgents(cards, enabled);
  const others = cards.filter((c) => !usable.includes(c));
  return (
    <div className="agent-pick">
      {usable.map((card) => {
        const ident = agentIdentity(card.id, card.name);
        return (
          <button
            key={card.id}
            type="button"
            className={`pick${picked === card.id ? " on" : ""}`}
            onClick={() =>
              prepared(card.id) ? onPick(card.id) : onGoSettings(card.id)
            }
          >
            <span className={`id ${ident.cls}`}>{ident.letter}</span>
            <span className="p-name">{card.name}</span>
            {!prepared(card.id) ? (
              <span className="p-model">{ACCESS_STRINGS.continueSetup}</span>
            ) : (
              card.status === "connected" && (
                <span className="p-model">
                  <i className="p-dot" />
                </span>
              )
            )}
          </button>
        );
      })}
      {others.map((card) => {
        const ident = agentIdentity(card.id, card.name);
        return (
          <button
            key={card.id}
            type="button"
            className="pick off"
            onClick={() => onGoSettings(card.id)}
          >
            <span className={`id ${ident.cls}`}>{ident.letter}</span>
            <span className="p-name">{card.name}</span>
            <span className="p-model">
              {!enabled(card.id)
                ? STRINGS.repair.workOff
                : STRINGS.switcher.notConnected}
            </span>
          </button>
        );
      })}
    </div>
  );
}
